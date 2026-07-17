import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';
import { sendSecurityAlertEmail } from './security-alert-email.js';

type RequestBucket = {
  count: number;
  resetAt: number;
};

const requestBuckets = new Map<string, RequestBucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = Number(process.env.BE_RATE_LIMIT_PER_MINUTE || 180);
const DDOS_TEMP_BAN_MINUTES = Math.max(1, Math.min(1440, Math.trunc(Number(process.env.BE_DDOS_TEMP_BAN_MINUTES || 15))));
const PROBE_PATH_PATTERN =
  /(?:^|\/)(?:wp-admin|wp-login|xmlrpc\.php|phpmyadmin|adminer|vendor\/phpunit|cgi-bin|shell|webshell|server-status|actuator|debug|backup|dump|database|db_backup)(?:\/|$)|(?:^|\/)\.(?:env|env\.[^/?#]+|git|svn|hg|htaccess|htpasswd|dockerignore|gitignore)(?:\/|$)|(?:^|\/)(?:composer\.(?:json|lock)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc|id_rsa|private\.key|config\.(?:json|php|bak)|credentials|secrets)(?:$|[/?#])|\.(?:bak|backup|old|orig|save|swp|sql|sqlite|sqlite3|db|pem|key|crt|log|map)(?:$|[?#])/i;

function firstHeaderIp(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0]?.split(',')[0]?.trim() || '';
  }
  return value?.split(',')[0]?.trim() || '';
}

export function getRequestIp(req: Request) {
  return (
    firstHeaderIp(req.headers['cf-connecting-ip'] as string | undefined) ||
    firstHeaderIp(req.headers['x-forwarded-for']) ||
    firstHeaderIp(req.headers['x-real-ip'] as string | undefined) ||
    req.ip ||
    'unknown'
  ).replace(/^::ffff:/, '');
}

function safeJson(value: unknown, max = 2000) {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return '';
  }
}

function detectRequestTool(req: Request, reason: string) {
  const userAgent = String(req.headers['user-agent'] || '');
  const haystack = `${userAgent} ${req.originalUrl || req.url || ''}`.toLowerCase();
  const knownTools = [
    'sqlmap',
    'nikto',
    'nuclei',
    'acunetix',
    'wpscan',
    'masscan',
    'zgrab',
    'python-requests',
    'go-http-client',
    'libwww-perl',
    'openbash',
  ];
  const matched = knownTools.find((tool) => haystack.includes(tool));
  if (matched) {
    return matched;
  }
  if (reason === 'known_probe_path') {
    return 'probe-path-scanner';
  }
  if (reason.includes('DDoS') || reason.includes('burst=')) {
    return 'request-burst';
  }
  return reason || 'unknown';
}

function requestSecurityDetails(req: Request, reason: string, extra: Record<string, unknown> = {}) {
  const originalUrl = req.originalUrl || req.url || '';
  const bodyExcerpt = req.method === 'GET' ? '' : safeJson(req.body || {});
  return {
    reason_code: reason,
    detected_tool: detectRequestTool(req, reason),
    tool_type: reason.includes('DDoS') || reason.includes('burst=') ? 'anti_ddos_rate_limit' : 'server_request_guard',
    request_path: originalUrl,
    request_method: req.method,
    user_agent: String(req.headers['user-agent'] || ''),
    query_excerpt: originalUrl.slice(0, 1200),
    body_excerpt: bodyExcerpt,
    attempted_code: bodyExcerpt || originalUrl.slice(0, 1200),
    ...extra,
  };
}

async function findRecentUserIdByIp(ip: string) {
  if (!ip || ip === 'unknown') {
    return null;
  }

  const directRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
      SELECT id
      FROM users
      WHERE last_ip = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    ip
  ).catch(() => []);

  if (directRows[0]?.id) {
    return Number(directRows[0].id);
  }

  const activityRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
      SELECT u.id
      FROM activity_logs l
      INNER JOIN users u ON u.id = l.user_id
      WHERE l.ip_address = ?
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1
    `,
    ip
  ).catch(() => []);

  return activityRows[0]?.id ? Number(activityRows[0].id) : null;
}

function isStaticOrHealth(req: Request) {
  return req.path === '/api/health' || req.path === '/health' || req.path.startsWith('/assets/');
}

function suspiciousReason(req: Request) {
  const userAgent = String(req.headers['user-agent'] || '');
  const query = String(req.originalUrl || req.url || '');
  const body = req.method === 'GET' ? '' : JSON.stringify(req.body || {}).slice(0, 2000);
  const haystack = `${query} ${body} ${userAgent}`.toLowerCase();

  if (/(sqlmap|nikto|nuclei|acunetix|wpscan|masscan|zgrab|python-requests|go-http-client|libwww-perl)/i.test(userAgent)) {
    return 'scanner_user_agent';
  }

  if (PROBE_PATH_PATTERN.test(req.path) || PROBE_PATH_PATTERN.test(query)) {
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

async function logSecurityEvent(req: Request, eventType: string, severity: 'HIGH' | 'CRITICAL', payload: string, autoBanned = false) {
  const ip = getRequestIp(req);
  const userId = await findRecentUserIdByIp(ip);
  const details = requestSecurityDetails(req, payload);
  const enrichedPayload = `${payload} | tool=${details.detected_tool} | path=${details.request_path}`.slice(0, 2000);
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO security_logs (event_type, severity, ip, user_id, uri, method, field, payload, user_agent, auto_banned)
      VALUES (?, ?, ?, ?, ?, ?, 'be_guard', ?, ?, ?)
    `,
    eventType,
    severity,
    ip,
    userId,
    req.originalUrl || req.url,
    req.method,
    enrichedPayload.slice(0, 400),
    String(req.headers['user-agent'] || '').slice(0, 500),
    autoBanned ? 1 : 0
  ).catch(() => undefined);
}

async function banIp(req: Request, reason: string) {
  const ip = getRequestIp(req);
  if (!ip || ip === 'unknown') {
    return;
  }
  const userId = await findRecentUserIdByIp(ip);

  const updated = await prisma.$executeRawUnsafe(
    `
      UPDATE banned_ips
      SET reason = ?, banned_by = 'auto', user_id = ?, expire_at = NULL, created_at = NOW()
      WHERE ip = ?
    `,
    reason,
    userId,
    ip
  ).catch(() => 0);

  if (Number(updated || 0) === 0) {
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO banned_ips (ip, reason, banned_by, user_id, expire_at, created_at)
        VALUES (?, ?, 'auto', ?, NULL, NOW())
      `,
      ip,
      reason,
      userId
    ).catch(() => undefined);
  }

  await sendSecurityAlertEmail({
    event: 'BE_SECURITY_IP_BANNED',
    title: 'BE đã khóa IP do request nguy hiểm',
    severity: 'CRITICAL',
    userId,
    ip,
    reason,
    path: req.originalUrl || req.url,
    method: req.method,
    userAgent: String(req.headers['user-agent'] || ''),
    details: requestSecurityDetails(req, reason, { user_id: userId }),
  }).catch(() => undefined);
}

async function temporaryBanIp(req: Request, reason: string, minutes = DDOS_TEMP_BAN_MINUTES) {
  const ip = getRequestIp(req);
  if (!ip || ip === 'unknown') {
    return;
  }
  const userId = await findRecentUserIdByIp(ip);

  const safeMinutes = Math.max(1, Math.min(1440, Math.trunc(Number(minutes || DDOS_TEMP_BAN_MINUTES))));
  const expireSql = `DATE_ADD(NOW(), INTERVAL ${safeMinutes} MINUTE)`;
  const updated = await prisma.$executeRawUnsafe(
    `
      UPDATE banned_ips
      SET reason = ?, banned_by = 'auto', user_id = ?, expire_at = ${expireSql}, created_at = NOW()
      WHERE ip = ?
    `,
    reason,
    userId,
    ip
  ).catch(() => 0);

  if (Number(updated || 0) === 0) {
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO banned_ips (ip, reason, banned_by, user_id, expire_at, created_at)
        VALUES (?, ?, 'auto', ?, ${expireSql}, NOW())
      `,
      ip,
      reason,
      userId
    ).catch(() => undefined);
  }

  await sendSecurityAlertEmail({
    event: 'BE_AI_DDOS_TEMP_BAN',
    title: 'BE anti-DDoS đã khóa tạm IP',
    severity: 'CRITICAL',
    userId,
    ip,
    reason,
    path: req.originalUrl || req.url,
    method: req.method,
    userAgent: String(req.headers['user-agent'] || ''),
    details: requestSecurityDetails(req, reason, { minutes: safeMinutes, user_id: userId }),
  }).catch(() => undefined);
}

async function isBlockedIp(req: Request) {
  const ip = getRequestIp(req);
  if (!ip || ip === 'unknown') {
    return false;
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ total: number | bigint }>>(
    `
      SELECT COUNT(*) AS total
      FROM banned_ips
      WHERE ip = ?
        AND (expire_at IS NULL OR expire_at > NOW())
    `,
    ip
  ).catch(() => []);

  return Number(rows[0]?.total || 0) > 0;
}

function isRateLimited(req: Request) {
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

function cleanupBuckets(now: number) {
  if (requestBuckets.size < 2000) {
    return;
  }

  for (const [key, bucket] of requestBuckets) {
    if (bucket.resetAt <= now) {
      requestBuckets.delete(key);
    }
  }
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export async function securityGuard(req: Request, res: Response, next: NextFunction) {
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
