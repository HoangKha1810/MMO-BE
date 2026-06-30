import nodemailer from 'nodemailer';

const DEFAULT_OWNER_ALERT_EMAIL = 'nhhkha.91tn@gmail.com';

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
    process.env.SECURITY_ALERT_RECIPIENTS ||
      process.env.OWNER_ALERT_EMAIL ||
      process.env.OWNER_EMAIL ||
      process.env.ADMIN_ALERT_RECIPIENTS ||
      DEFAULT_OWNER_ALERT_EMAIL
  );
  return recipients.length > 0 ? recipients : [DEFAULT_OWNER_ALERT_EMAIL];
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendSecurityAlertEmail(input: {
  event: string;
  title: string;
  severity?: 'HIGH' | 'CRITICAL';
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
  const rows = [
    ['Mức độ', severity],
    ['Sự kiện', input.event],
    ['IP', input.ip || 'unknown'],
    ['Lý do', input.reason || ''],
    ['Path', input.path || ''],
    ['Method', input.method || ''],
    ['User-Agent', input.userAgent || ''],
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

  const result = await transporter.sendMail({
    from: user,
    replyTo: process.env.ADMIN_ALERT_FROM_EMAIL || process.env.OWNER_EMAIL || undefined,
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
