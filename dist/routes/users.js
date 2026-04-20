import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';
const router = Router();
router.get('/me', async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            email: true,
            fullname: true,
            avatar: true,
            balance: true,
            rank: true,
            role: true,
            is_blue_tick: true,
        },
    });
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, user });
});
router.get('/orders', async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const [smmOrders, cardOrders, deposits, resourceOrders] = await Promise.all([
        prisma.smm_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 }),
        prisma.card_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 }),
        prisma.deposit_transactions.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 }),
        prisma.resource_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10, include: { resource: true } }),
    ]);
    return res.json({
        success: true,
        data: { smmOrders, cardOrders, deposits, resourceOrders },
    });
});
export default router;
