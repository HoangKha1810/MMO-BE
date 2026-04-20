import { createHash } from 'node:crypto';
export function hashPassword(password) {
    return createHash('sha256').update(password).digest('hex');
}
export function getUserId(req) {
    return Number(req.cookies?.user_id || 0);
}
export function setSessionCookie(res, userId) {
    res.cookie('user_id', String(userId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 1000 * 60 * 60 * 24 * 30,
    });
}
export function clearSessionCookie(res) {
    res.clearCookie('user_id', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
    });
}
