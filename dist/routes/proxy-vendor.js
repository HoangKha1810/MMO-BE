import { Router } from 'express';
import { z } from 'zod';
const router = Router();
const DEFAULT_PROXY_BASE_URL = 'https://proxy.vncloud.net/api/v1';
const requestSchema = z.object({
    baseUrl: z.string().url().optional(),
    path: z.string().min(1),
    method: z.enum(['GET', 'POST']).default('GET'),
    query: z.record(z.string()).optional(),
    body: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
});
function compactPreview(value, maxLength = 220) {
    const normalized = value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized)
        return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
function buildDebugMessage(response, rawText) {
    const contentType = response.headers.get('content-type') || 'unknown';
    const server = response.headers.get('server') || 'unknown';
    const cfRay = response.headers.get('cf-ray') || '';
    const preview = compactPreview(rawText);
    const parts = [
        `HTTP ${response.status}`,
        `content-type: ${contentType}`,
        `server: ${server}`,
    ];
    if (cfRay) {
        parts.push(`cf-ray: ${cfRay}`);
    }
    if (preview) {
        parts.push(`body: ${preview}`);
    }
    return parts.join(' | ');
}
function getRelaySecret() {
    return String(process.env.PROXY_VNCLOUD_RELAY_SECRET || process.env.ENCRYPTION_KEY || '').trim();
}
router.post('/request', async (req, res) => {
    const relaySecret = getRelaySecret();
    if (!relaySecret) {
        return res.status(503).json({
            status: 'error',
            message: 'Relay proxy chưa được cấu hình secret ở backend.',
        });
    }
    const incomingSecret = String(req.header('x-relay-secret') || '').trim();
    if (!incomingSecret || incomingSecret !== relaySecret) {
        return res.status(403).json({
            status: 'error',
            message: 'Forbidden relay request',
        });
    }
    const vendorToken = String(req.header('x-vncloud-token') ||
        req.header('x-api-token') ||
        process.env.PROXY_VNCLOUD_TOKEN ||
        '').trim();
    if (!vendorToken) {
        return res.status(400).json({
            status: 'error',
            message: 'Thiếu token vendor để relay request',
        });
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            status: 'error',
            message: 'Payload relay proxy không hợp lệ',
        });
    }
    const baseUrl = String(parsed.data.baseUrl || process.env.PROXY_VNCLOUD_BASE_URL || DEFAULT_PROXY_BASE_URL)
        .trim()
        .replace(/\/+$/, '');
    const pathname = parsed.data.path.startsWith('/') ? parsed.data.path : `/${parsed.data.path}`;
    const url = new URL(`${baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(parsed.data.query || {})) {
        if (String(value || '').trim()) {
            url.searchParams.set(key, String(value));
        }
    }
    try {
        const response = await fetch(url.toString(), {
            method: parsed.data.method,
            headers: {
                'X-Api-Token': vendorToken,
                Accept: 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            },
            body: parsed.data.method === 'POST' ? JSON.stringify(parsed.data.body || {}) : undefined,
            redirect: 'follow',
            signal: AbortSignal.timeout(parsed.data.timeoutMs || 15000),
        });
        const rawText = await response.text();
        let payload = null;
        try {
            payload = rawText ? JSON.parse(rawText) : {};
        }
        catch {
            return res.status(502).json({
                status: 'error',
                message: `Proxy vendor trả về HTML thay vì JSON. ${buildDebugMessage(response, rawText)}`,
            });
        }
        if (payload && typeof payload === 'object') {
            return res.status(response.status).json(payload);
        }
        return res.status(502).json({
            status: 'error',
            message: `Proxy vendor trả về dữ liệu JSON không hợp lệ. ${buildDebugMessage(response, rawText)}`,
        });
    }
    catch (error) {
        return res.status(502).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'Relay proxy request failed',
        });
    }
});
export default router;
