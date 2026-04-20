import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';

const router = Router();

router.get('/', async (_req, res) => {
  const resources = await prisma.mmo_resources.findMany({
    where: { status: 'active' },
    orderBy: { created_at: 'desc' },
    take: 200,
  });

  return res.json({ success: true, data: resources });
});

router.get('/orders', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const orders = await prisma.resource_orders.findMany({
    where: { user_id: userId },
    include: { resource: true },
    orderBy: { created_at: 'desc' },
  });

  return res.json({ success: true, data: orders });
});

router.get('/cart', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const cart = await prisma.cart_items.findMany({
    where: { user_id: userId },
    include: { resource: true },
    orderBy: { created_at: 'desc' },
  });

  return res.json({ success: true, data: cart });
});

router.post('/cart', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const schema = z.object({
    resource_id: z.coerce.number().positive(),
    quantity: z.coerce.number().positive().default(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Dữ liệu cart không hợp lệ' });
  }

  const item = await prisma.cart_items.upsert({
    where: {
      user_id_resource_id: {
        user_id: userId,
        resource_id: parsed.data.resource_id,
      },
    },
    update: {
      quantity: { increment: parsed.data.quantity },
    },
    create: {
      user_id: userId,
      resource_id: parsed.data.resource_id,
      quantity: parsed.data.quantity,
    },
    include: { resource: true },
  });

  return res.json({ success: true, data: item });
});

router.delete('/cart/:id', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const itemId = Number(req.params.id);

  const item = await prisma.cart_items.findFirst({
    where: {
      id: itemId,
      user_id: userId,
    },
  });

  if (!item) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy item' });
  }

  await prisma.cart_items.delete({ where: { id: itemId } });
  return res.json({ success: true });
});

export default router;
