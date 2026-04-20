import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { clearSessionCookie, hashPassword, setSessionCookie } from '../lib/auth.js';
const router = Router();
router.post('/register', async (req, res) => {
    const schema = z.object({
        username: z.string().min(3).max(50),
        email: z.string().email(),
        password: z.string().min(8),
        fullname: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Dữ liệu đăng ký không hợp lệ' });
    }
    const { username, email, password, fullname } = parsed.data;
    const existing = await prisma.users.findFirst({
        where: {
            OR: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }],
        },
    });
    if (existing) {
        return res.status(409).json({ success: false, message: 'Username hoặc email đã tồn tại' });
    }
    const user = await prisma.users.create({
        data: {
            username: username.toLowerCase(),
            email: email.toLowerCase(),
            password: hashPassword(password),
            fullname: fullname || username,
            role: 'user',
            status: 'active',
            rank: 'Thành viên',
            balance: 0,
        },
        select: {
            id: true,
            username: true,
            email: true,
            rank: true,
            role: true,
        },
    });
    return res.json({ success: true, user });
});
router.post('/login', async (req, res) => {
    const schema = z.object({
        username: z.string().min(1),
        password: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng nhập' });
    }
    const { username, password } = parsed.data;
    const user = await prisma.users.findFirst({
        where: {
            OR: [{ username: username.toLowerCase() }, { email: username.toLowerCase() }],
        },
    });
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ success: false, message: 'Thông tin đăng nhập không đúng' });
    }
    if (user.status !== 'active') {
        return res.status(403).json({ success: false, message: 'Tài khoản không khả dụng' });
    }
    setSessionCookie(res, user.id);
    return res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            balance: user.balance,
            rank: user.rank,
            role: user.role,
            avatar: user.avatar,
            is_blue_tick: user.is_blue_tick,
        },
    });
});
router.post('/logout', async (_req, res) => {
    clearSessionCookie(res);
    return res.json({ success: true });
});
export default router;
