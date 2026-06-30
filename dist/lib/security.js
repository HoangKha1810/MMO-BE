import { prisma } from './prisma.js';
import { sendSecurityAlertEmail } from './security-alert-email.js';
const requestBuckets = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = Number(process.env.BE_RATE_LIMIT_PER_MINUTE || 180);
const DDOS_TEMP_BAN_MINUTES = Math.max(1, Math.min(1440, Math.trunc(Number(process.env.BE_DDOS_TEMP_BAN_MINUTES || 15))));
function firstHeaderIp(value) {
    if (Array.isArray(value)) {
        return value[0]?.split(',')[0]?.trim() || '';
    }
    return value?.split(',')[0]?.trim() || '';
}
export function getRequestIp(req) {
    return (firstHeaderIp(req.headers['cf-connecting-ip']) ||
        firstHeaderIp(req.headers['x-forwarded-for']) ||
        firstHeaderIp(req.headers['x-real-ip']) ||
        req.ip ||
        'unknown').replace(/^::ffff:/, '');
}
function isStaticOrHealth(req) {
    return req.path === '/api/health' || req.path === '/health' || req.path.startsWith('/assets/');
}
function suspiciousReason(req) {
    const userAgent = String(req.headers['user-agent'] || '');
    const query = String(req.originalUrl || req.url || '');
    const body = req.method === 'GET' ? '' : JSON.stringify(req.body || {}).slice(0, 2000);
    const haystack = `${query} ${body} ${userAgent}`.toLowerCase();
    if (/(sqlmap|nikto|nuclei|acunetix|wpscan|masscan|zgrab|python-requests|go-http-client|libwww-perl)/i.test(userAgent)) {
        return 'scanner_user_agent';
    }
    if (/(\/wp-admin|\/wp-login|\/xmlrpc\.php|\/phpmyadmin|\/\.env|\/\.git|\/vendor\/phpunit|\/cgi-bin|\/shell|\/webshell)/i.test(req.path)) {
        return 'known_probe_path';
    }
    if (/(union\s+select|information_schema|sleep\s*\(|benchmark\s*\(|drop\s+table|or\s+1\s*=\s*1)/i.test(haystack)) {
        return 'sql_injection_signature';
    }
    if (/(<script|javascript:|document\.cookie|localstorage|sessionstorage|onerror\s*=|onload\s*=)/i.test(haystack)) {
        return 'xss_signature';
    }
    if (/(\.\.\/|\.\.\\|%2e%2e|etc\/passwd|\/proc\/self|boot\.ini)/i.test(haystack)) {
        return 'path_traversal_signature';
    }
    return '';
}
async function logSecurityEvent(req, eventType, severity, payload, autoBanned = false) {
    const ip = getRequestIp(req);
    await prisma.$executeRawUnsafe(`
      INSERT INTO security_logs (event_type, severity, ip, user_id, uri, method, field, payload, user_agent, auto_banned)
      VALUES (?, ?, ?, NULL, ?, ?, 'be_guard', ?, ?, ?)
    `, eventType, severity, ip, req.originalUrl || req.url, req.method, payload.slice(0, 400), String(req.headers['user-agent'] || '').slice(0, 500), autoBanned ? 1 : 0).catch(() => undefined);
}
async function banIp(req, reason) {
    const ip = getRequestIp(req);
    if (!ip || ip === 'unknown') {
        return;
    }
    const updated = await prisma.$executeRawUnsafe(`
      UPDATE banned_ips
      SET reason = ?, banned_by = 'auto', expire_at = NULL, created_at = NOW()
      WHERE ip = ?
    `, reason, ip).catch(() => 0);
    if (Number(updated || 0) === 0) {
        await prisma.$executeRawUnsafe(`
        INSERT INTO banned_ips (ip, reason, banned_by, user_id, expire_at, created_at)
        VALUES (?, ?, 'auto', NULL, NULL, NOW())
      `, ip, reason).catch(() => undefined);
    }
    await sendSecurityAlertEmail({
        event: 'BE_SECURITY_IP_BANNED',
        title: 'BE đã khóa IP do request nguy hiểm',
        severity: 'CRITICAL',
        ip,
        reason,
        path: req.originalUrl || req.url,
        method: req.method,
        userAgent: String(req.headers['user-agent'] || ''),
    }).catch(() => undefined);
}
async function temporaryBanIp(req, reason, minutes = DDOS_TEMP_BAN_MINUTES) {
    const ip = getRequestIp(req);
    if (!ip || ip === 'unknown') {
        return;
    }
    const safeMinutes = Math.max(1, Math.min(1440, Math.trunc(Number(minutes || DDOS_TEMP_BAN_MINUTES))));
    const expireSql = `DATE_ADD(NOW(), INTERVAL ${safeMinutes} MINUTE)`;
    const updated = await prisma.$executeRawUnsafe(`
      UPDATE banned_ips
      SET reason = ?, banned_by = 'auto', expire_at = ${expireSql}, created_at = NOW()
      WHERE ip = ?
    `, reason, ip).catch(() => 0);
    if (Number(updated || 0) === 0) {
        await prisma.$executeRawUnsafe(`
        INSERT INTO banned_ips (ip, reason, banned_by, user_id, expire_at, created_at)
        VALUES (?, ?, 'auto', NULL, ${expireSql}, NOW())
      `, ip, reason).catch(() => undefined);
    }
    await sendSecurityAlertEmail({
        event: 'BE_AI_DDOS_TEMP_BAN',
        title: 'BE anti-DDoS đã khóa tạm IP',
        severity: 'CRITICAL',
        ip,
        reason,
        path: req.originalUrl || req.url,
        method: req.method,
        userAgent: String(req.headers['user-agent'] || ''),
        details: { minutes: safeMinutes },
    }).catch(() => undefined);
}
async function isBlockedIp(req) {
    const ip = getRequestIp(req);
    if (!ip || ip === 'unknown') {
        return false;
    }
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*) AS total
      FROM banned_ips
      WHERE ip = ?
        AND (expire_at IS NULL OR expire_at > NOW())
    `, ip).catch(() => []);
    return Number(rows[0]?.total || 0) > 0;
}
function isRateLimited(req) {
    if (isStaticOrHealth(req)) {
        return false;
    }
    const ip = getRequestIp(req);
    const key = `${ip}:${req.path.startsWith('/api') ? 'api' : 'root'}`;
    const now = Date.now();
    const bucket = requestBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        requestBuckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return false;
    }
    bucket.count += 1;
    return bucket.count > MAX_REQUESTS;
}
function cleanupBuckets(now) {
    if (requestBuckets.size < 2000) {
        return;
    }
    for (const [key, bucket] of requestBuckets) {
        if (bucket.resetAt <= now) {
            requestBuckets.delete(key);
        }
    }
}
export function securityHeaders(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
}
export async function securityGuard(req, res, next) {
    if (await isBlockedIp(req)) {
        return res.status(403).json({
            success: false,
            code: 'IP_BLOCKED',
            message: 'IP đã bị hệ thống bảo mật khóa. Liên hệ owner để mở khóa.',
        });
    }
    const reason = suspiciousReason(req);
    if (reason) {
        await logSecurityEvent(req, 'BE_SECURITY_BLOCKED', 'CRITICAL', reason, true);
        await banIp(req, `BE security guard: ${reason}`);
        return res.status(403).json({
            success: false,
            code: 'SECURITY_BLOCKED',
            message: 'Request bị hệ thống bảo mật chặn.',
        });
    }
    if (isRateLimited(req)) {
        const ip = getRequestIp(req);
        const now = Date.now();
        cleanupBuckets(now);
        const apiBucket = requestBuckets.get(`${ip}:api`);
        const rootBucket = requestBuckets.get(`${ip}:root`);
        const totalBurst = Number(apiBucket?.count || 0) + Number(rootBucket?.count || 0);
        const shouldTempBan = totalBurst > MAX_REQUESTS * 2 || Boolean(apiBucket && apiBucket.count > MAX_REQUESTS * 1.35);
        const reason = shouldTempBan
            ? `BE AI anti-DDoS temporary ban: burst=${totalBurst}, limit=${MAX_REQUESTS}/min`
            : 'rate_limit';
        await logSecurityEvent(req, shouldTempBan ? 'BE_AI_DDOS_TEMP_BAN' : 'BE_RATE_LIMIT', shouldTempBan ? 'CRITICAL' : 'HIGH', reason, shouldTempBan);
        if (shouldTempBan) {
            await temporaryBanIp(req, reason);
        }
        return res.status(429).json({
            success: false,
            code: shouldTempBan ? 'IP_BLOCKED' : 'RATE_LIMIT',
            blocked: shouldTempBan,
            message: shouldTempBan
                ? 'IP bị hệ thống anti-DDoS khóa tạm thời. Vui lòng thử lại sau hoặc liên hệ owner.'
                : 'Bạn thao tác quá nhanh, vui lòng thử lại sau.',
        });
    }
    return next();
}
