import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';
import { tableExists } from '../lib/table-exists.js';
const router = Router();
router.get('/me', async (req, res) => {
    const userId = await getUserId(req);
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
    const userId = await getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const hasCardOrders = await tableExists('card_orders');
    const [smmOrders, cardOrders, deposits, resourceOrders] = await Promise.all([
        prisma.smm_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 }),
        hasCardOrders
            ? prisma.card_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 })
            : Promise.resolve([]),
        prisma.deposit_transactions.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10 }),
        prisma.resource_orders.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 10, include: { resource: true } }),
    ]);
    return res.json({
        success: true,
        data: { smmOrders, cardOrders, deposits, resourceOrders },
    });
});
export default router;
