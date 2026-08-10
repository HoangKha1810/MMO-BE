import nodemailer from 'nodemailer';
import { prisma } from './prisma.js';

const DEFAULT_OWNER_ALERT_EMAIL = 'nhathuyfamily@gmail.com';

type AlertUser = {
  id: number | null;
  username: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
};

function parseBoolean(value: unknown, fallback: boolean) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeRecipients(value: string) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[,\n;]+/)
        .map((item) => item.trim())
        .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    )
  );
}

function alertRecipients() {
  const recipients = normalizeRecipients(
    process.env.ADMIN_ALERT_RECIPIENTS ||
      process.env.SECURITY_ALERT_RECIPIENTS ||
      process.env.OWNER_ALERT_EMAIL ||
      process.env.OWNER_EMAIL ||
      DEFAULT_OWNER_ALERT_EMAIL
  );
  return recipients.length > 0 ? recipients : [DEFAULT_OWNER_ALERT_EMAIL];
}

function buildFromAddress(smtpUser: string) {
  const requestedFrom = String(
    process.env.ADMIN_ALERT_FROM_EMAIL ||
      process.env.SECURITY_ALERT_FROM_EMAIL ||
      smtpUser ||
      DEFAULT_OWNER_ALERT_EMAIL
  ).trim();
  const from = requestedFrom || smtpUser || DEFAULT_OWNER_ALERT_EMAIL;

  return {
    from,
    sender: smtpUser && smtpUser !== from ? smtpUser : undefined,
    replyTo: from && from !== smtpUser ? from : undefined,
  };
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function compactText(value: unknown, max = 1200) {
  if (value == null) {
    return '';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function detailValue(details: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!details) {
    return '';
  }
  for (const key of keys) {
    const value = details[key];
    if (value != null && String(value).trim()) {
      return compactText(value);
    }
  }
  return '';
}

function detailNumber(details: Record<string, unknown> | null | undefined, keys: string[]) {
  const raw = detailValue(details, keys);
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function readAlertUserById(userId: number | null): Promise<AlertUser | null> {
  if (!userId || !Number.isFinite(userId)) {
    return null;
  }

  const rows = await prisma.$queryRawUnsafe<AlertUser[]>(
    `
      SELECT id, username, email, role, status
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    userId
  ).catch(() => []);

  return rows[0] || null;
}

async function readAlertUserByIp(ip: string | null | undefined): Promise<AlertUser | null> {
  const normalizedIp = String(ip || '').trim();
  if (!normalizedIp || normalizedIp === 'unknown') {
    return null;
  }

  const directRows = await prisma.$queryRawUnsafe<AlertUser[]>(
    `
      SELECT id, username, email, role, status
      FROM users
      WHERE last_ip = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    normalizedIp
  ).catch(() => []);

  if (directRows[0]) {
    return directRows[0];
  }

  const activityRows = await prisma.$queryRawUnsafe<AlertUser[]>(
    `
      SELECT u.id, u.username, u.email, u.role, u.status
      FROM activity_logs l
      INNER JOIN users u ON u.id = l.user_id
      WHERE l.ip_address = ?
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1
    `,
    normalizedIp
  ).catch(() => []);

  return activityRows[0] || null;
}

async function resolveAlertUser(input: {
  userId?: number | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}) {
  const userId = input.userId ?? detailNumber(input.details, ['user_id', 'userId', 'subject_user_id']);
  return (await readAlertUserById(userId)) || (await readAlertUserByIp(input.ip));
}

export async function sendSecurityAlertEmail(input: {
  event: string;
  title: string;
  severity?: 'HIGH' | 'CRITICAL';
  userId?: number | null;
  username?: string | null;
  email?: string | null;
  ip?: string | null;
  reason?: string | null;
  path?: string | null;
  method?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}) {
  const host = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = parseBoolean(process.env.SMTP_SECURE || (port === 465 ? '1' : '0'), port === 465);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  if (!user || !pass) {
    return { sent: false, skipped: true, reason: 'BE thiếu SMTP_USER hoặc SMTP_PASS.' };
  }

  const recipients = alertRecipients();
  const severity = input.severity || 'HIGH';
  const details = input.details || null;
  const resolvedUser = await resolveAlertUser({
    userId: input.userId ?? null,
    ip: input.ip || detailValue(details, ['ip', 'request_ip']) || null,
    details,
  });
  const userId = input.userId ?? resolvedUser?.id ?? detailNumber(details, ['user_id', 'userId', 'subject_user_id']);
  const username = input.username || resolvedUser?.username || detailValue(details, ['username', 'subject_username']);
  const email = input.email || resolvedUser?.email || detailValue(details, ['email', 'subject_email']);
  const role = resolvedUser?.role || detailValue(details, ['role']);
  const status = resolvedUser?.status || detailValue(details, ['status', 'user_status_before']);
  const reason = input.reason || detailValue(details, ['reason', 'reason_code', 'event_type']);
  const path = input.path || detailValue(details, ['path', 'request_path', 'uri']);
  const method = input.method || detailValue(details, ['method', 'request_method']);
  const userAgent = input.userAgent || detailValue(details, ['user_agent', 'userAgent', 'client_user_agent']);
  const detectedTool = detailValue(details, ['detected_tool', 'tool_name', 'toolName', 'scanner', 'runtime_marker', 'signal']);
  const toolType = detailValue(details, ['tool_type', 'toolType', 'event_type']);
  const attemptedCode = detailValue(details, ['attempted_code', 'attemptedCode', 'payload', 'body_excerpt', 'query_excerpt']);
  const rows = [
    ['Mức độ', severity],
    ['Sự kiện', input.event],
    ['IP', input.ip || 'unknown'],
    ['User ID', userId || ''],
    ['Username', username || ''],
    ['Email', email || ''],
    ['Role', role || ''],
    ['Trạng thái', status || ''],
    ['Lý do', reason],
    ['Hành vi/tool', detectedTool],
    ['Loại tool', toolType],
    ['Code/payload bị chặn', attemptedCode],
    ['Path', path],
    ['Method', method],
    ['User-Agent', userAgent],
    ['Thời gian', new Date().toISOString()],
  ];

  const text = [
    `[${severity}] ${input.title}`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    input.details ? ['', 'Details:', JSON.stringify(input.details, null, 2)] : '',
  ].flat().filter(Boolean).join('\n');

  const htmlRows = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:700;width:150px;">${escapeHtml(label)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#0f172a;word-break:break-word;">${escapeHtml(value)}</td>
      </tr>
    `)
    .join('');

  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) && port > 0 ? Math.trunc(port) : 465,
    secure,
    auth: { user, pass },
  });
  const fromAddress = buildFromAddress(user);

  const result = await transporter.sendMail({
    from: fromAddress.from,
    sender: fromAddress.sender,
    replyTo: fromAddress.replyTo,
    to: recipients.join(', '),
    subject: `[TRUNGTAMMMO BE SECURITY] ${severity} - ${input.title}`,
    text,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#020617;padding:24px;">
        <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;">
          <div style="padding:22px 26px;background:linear-gradient(135deg,#991b1b,#0f172a);color:#ffffff;">
            <div style="font-size:11px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;opacity:.8;">TRUNGTAMMMO BE SECURITY</div>
            <h1 style="margin:10px 0 0;font-size:26px;line-height:1.25;">${escapeHtml(input.title)}</h1>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">${htmlRows}</table>
          ${
            input.details
              ? `<pre style="white-space:pre-wrap;margin:18px 26px 26px;padding:14px;border-radius:12px;background:#f8fafc;color:#0f172a;border:1px solid #e2e8f0;">${escapeHtml(JSON.stringify(input.details, null, 2))}</pre>`
              : ''
          }
        </div>
      </div>
    `,
  });

  return {
    sent: true,
    skipped: false,
    recipients,
    accepted: result.accepted,
    rejected: result.rejected,
    message_id: result.messageId,
  };
}
