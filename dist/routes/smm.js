import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';
const router = Router();
router.get('/services', async (_req, res) => {
    const services = await prisma.smm_services.findMany({
        where: { status: 'active' },
        orderBy: [{ platform: 'asc' }, { id: 'asc' }],
        take: 200,
    });
    return res.json({ success: true, data: services });
});
router.post('/orders', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const schema = z.object({
        service_id: z.coerce.number().positive(),
        quantity: z.coerce.number().int().positive().max(10_000_000),
        link: z.string().trim().min(1).max(5000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Dữ liệu order SMM không hợp lệ' });
    }
    const service = await prisma.smm_services.findFirst({
        where: {
            id: parsed.data.service_id,
            status: 'active',
        },
    });
    if (!service) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ hoặc dịch vụ đã tắt' });
    }
    if (parsed.data.quantity < service.min_quantity || parsed.data.quantity > service.max_quantity) {
        return res.status(400).json({
            success: false,
            message: `Số lượng phải từ ${service.min_quantity} đến ${service.max_quantity}`,
        });
    }
    const amount = Math.ceil((parsed.data.quantity / 1000) * Number(service.price_per_1k || 0));
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Giá dịch vụ không hợp lệ' });
    }
    try {
        const order = await prisma.$transaction(async (tx) => {
            const debit = await tx.users.updateMany({
                where: {
                    id: userId,
                    status: 'active',
                    balance: { gte: amount },
                },
                data: {
                    balance: { decrement: amount },
                },
            });
            if (debit.count !== 1) {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            return tx.smm_orders.create({
                data: {
                    user_id: userId,
                    service_id: service.id,
                    service_name: service.name,
                    platform: service.platform,
                    quantity: parsed.data.quantity,
                    link: parsed.data.link,
                    amount,
                    status: 'pending',
                },
            });
        });
        return res.json({ success: true, data: order });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'INSUFFICIENT_BALANCE') {
            return res.status(402).json({ success: false, message: 'Số dư không đủ để tạo đơn SMM' });
        }
        console.error('[smm/orders] create order failed', error);
        return res.status(500).json({ success: false, message: 'Không thể tạo đơn SMM lúc này' });
    }
});
router.get('/orders', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const orders = await prisma.smm_orders.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, data: orders });
});
export default router;
