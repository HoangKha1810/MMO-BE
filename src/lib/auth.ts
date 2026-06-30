import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from './prisma.js';

const LEGACY_USER_ID_COOKIE = 'user_id';
const SESSION_COOKIE = 'ttmmo_session';

function base64url(input: Buffer) {
  return input.toString('base64url');
}

function getSessionSecret() {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.JWT_SECRET ||
    process.env.APP_KEY ||
    '';

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing SESSION_SECRET for signed sessions');
  }

  return 'development-only-session-secret-change-in-env';
}

function signPayload(payload: string) {
  return base64url(createHmac('sha256', getSessionSecret()).update(payload).digest());
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashPassword(password: string) {
  return createHash('sha256').update(password).digest('hex');
}

export async function verifyPassword(password: string, hash: string) {
  const normalizedHash = String(hash || '');
  if (!normalizedHash) {
    return false;
  }

  if (normalizedHash.startsWith('$2')) {
    const bcrypt = await import('bcryptjs');
    return bcrypt.compare(String(password), normalizedHash);
  }

  return normalizedHash === hashPassword(password);
}

function createSignedSessionToken(userId: number, maxAgeSeconds: number) {
  const safeUserId = Math.trunc(Number(userId || 0));
  const expiresAt = Date.now() + Math.max(1, Math.trunc(maxAgeSeconds)) * 1000;
  const payload = `v1.${safeUserId}.${expiresAt}`;
  return `${payload}.${signPayload(payload)}`;
}

function verifySignedSessionToken(userId: number, token: string | undefined) {
  const safeUserId = Math.trunc(Number(userId || 0));
  if (!safeUserId || !token) {
    return false;
  }

  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return false;
  }

  const tokenUserId = Math.trunc(Number(parts[1] || 0));
  const expiresAt = Number(parts[2] || 0);
  if (tokenUserId !== safeUserId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }

  return safeEqual(signPayload(parts.slice(0, 3).join('.')), parts[3]);
}

export async function getUserId(req: Request) {
  const userId = Math.trunc(Number(req.cookies?.[LEGACY_USER_ID_COOKIE] || 0));
  if (!verifySignedSessionToken(userId, req.cookies?.[SESSION_COOKIE])) {
    return 0;
  }

  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { status: true },
  }).catch(() => null);

  return String(user?.status || '').toLowerCase() === 'active' ? userId : 0;
}

export function setSessionCookie(res: Response, userId: number) {
  const maxAgeMs = 1000 * 60 * 60 * 24 * 30;
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeMs,
  } as const;

  res.cookie(LEGACY_USER_ID_COOKIE, String(userId), cookieOptions);
  res.cookie(SESSION_COOKIE, createSignedSessionToken(userId, Math.floor(maxAgeMs / 1000)), cookieOptions);
}

export function clearSessionCookie(res: Response) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  } as const;

  res.clearCookie(LEGACY_USER_ID_COOKIE, cookieOptions);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}
