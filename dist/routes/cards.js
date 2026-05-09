import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';
import { tableExists } from '../lib/table-exists.js';
const router = Router();
router.post('/exchange', async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!(await tableExists('card_orders'))) {
        return res.status(503).json({ success: false, message: 'Module thẻ cào chưa được cấu hình trong cơ sở dữ liệu hiện tại' });
    }
    const schema = z.object({
        telco: z.string().min(1),
        amount: z.coerce.number().positive(),
        serial: z.string().min(1),
        pin: z.string().min(1),
        type: z.enum(['exchange', 'buy']).default('exchange'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Dữ liệu thẻ không hợp lệ' });
    }
    const order = await prisma.card_orders.create({
        data: {
            user_id: userId,
            type: parsed.data.type,
            telco: parsed.data.telco,
            card_amount: parsed.data.amount,
            amount: parsed.data.amount,
            serial: parsed.data.serial,
            pin: parsed.data.pin,
            status: 'pending',
        },
    });
    return res.json({ success: true, data: order });
});
router.get('/orders', async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!(await tableExists('card_orders'))) {
        return res.json({ success: true, data: [] });
    }
    const orders = await prisma.card_orders.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, data: orders });
});
export default router;
