import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';
import { callLegacyApi, getLegacyApiConfig } from '../lib/legacy-api.js';

const router = Router();

async function getUserRole(userId: number) {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  return String(user?.role || '');
}

router.get('/config', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const role = await getUserRole(userId);
  if (role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const config = getLegacyApiConfig();
  return res.json({
    success: true,
    data: {
      domain: config.domain,
      hasApiKey: Boolean(config.apiKey),
      authHeader: 'api-token',
    },
  });
});

router.post('/request', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const role = await getUserRole(userId);
  if (role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const schema = z.object({
    endpoint: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    data: z.record(z.unknown()).nullable().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Payload không hợp lệ' });
  }

  try {
    const upstream = await callLegacyApi({
      endpoint: parsed.data.endpoint,
      method: parsed.data.method,
      data: parsed.data.data || undefined,
    });

    return res.status(upstream.status).json({
      success: upstream.ok,
      status: upstream.status,
      data: upstream.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Legacy API request failed',
    });
  }
});

export default router;
