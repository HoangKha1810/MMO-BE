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
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const schema = z.object({
        service_id: z.coerce.number().positive(),
        quantity: z.coerce.number().positive(),
        link: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Dữ liệu order SMM không hợp lệ' });
    }
    const service = await prisma.smm_services.findUnique({ where: { id: parsed.data.service_id } });
    if (!service) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' });
    }
    const amount = (parsed.data.quantity / 1000) * service.price_per_1k;
    const order = await prisma.smm_orders.create({
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
    return res.json({ success: true, data: order });
});
router.get('/orders', async (req, res) => {
    const userId = getUserId(req);
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
