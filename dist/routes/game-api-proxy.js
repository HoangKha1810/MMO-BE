import { Router } from 'express';
const router = Router();
const DEFAULT_GAME_API_PROXY_TARGET = 'https://trungtammmo.vn';
const gameApiEndpoints = ['/profile.php', '/products.php', '/product.php', '/order.php', '/buy_product'];
function getTargetOrigin() {
    return String(process.env.GAME_API_PROXY_TARGET || DEFAULT_GAME_API_PROXY_TARGET)
        .trim()
        .replace(/\/+$/, '');
}
function appendQueryParams(target, req) {
    for (const [key, value] of Object.entries(req.query)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined) {
                    target.searchParams.append(key, String(item));
                }
            }
            continue;
        }
        if (value !== undefined) {
            target.searchParams.set(key, String(value));
        }
    }
}
function buildTargetUrl(req) {
    const endpoint = req.path.replace(/^\/+/, '');
    const target = new URL(`/${endpoint}`, `${getTargetOrigin()}/`);
    appendQueryParams(target, req);
    return target;
}
function buildForwardHeaders(req) {
    const headers = new Headers();
    const contentType = req.header('content-type');
    const apiKey = req.header('x-api-key');
    const authorization = req.header('authorization');
    const accept = req.header('accept');
    if (contentType) {
        headers.set('content-type', contentType);
    }
    if (apiKey) {
        headers.set('x-api-key', apiKey);
    }
    if (authorization) {
        headers.set('authorization', authorization);
    }
    headers.set('accept', accept || 'application/json, text/plain, */*');
    headers.set('x-forwarded-host', req.get('host') || '');
    headers.set('x-forwarded-proto', req.protocol || 'https');
    return headers;
}
function buildForwardBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return undefined;
    }
    const contentType = String(req.header('content-type') || '').toLowerCase();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (contentType.includes('application/x-www-form-urlencoded')) {
        return new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value ?? '')])).toString();
    }
    return JSON.stringify(body);
}
async function proxyGameApiRequest(req, res) {
    try {
        const target = buildTargetUrl(req);
        const upstream = await fetch(target, {
            method: req.method,
            headers: buildForwardHeaders(req),
            body: buildForwardBody(req),
            redirect: 'manual',
        });
        const contentType = upstream.headers.get('content-type');
        const body = await upstream.text();
        if (contentType) {
            res.setHeader('content-type', contentType);
        }
        return res.status(upstream.status).send(body);
    }
    catch (error) {
        return res.status(502).json({
            status: 'error',
            msg: error instanceof Error ? error.message : 'Không thể proxy Game API',
        });
    }
}
router.all(gameApiEndpoints, proxyGameApiRequest);
export default router;
