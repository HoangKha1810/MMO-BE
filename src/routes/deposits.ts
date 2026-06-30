import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserId } from '../lib/auth.js';

const router = Router();

router.get('/', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const transactions = await prisma.deposit_transactions.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
  });

  return res.json({ success: true, data: transactions });
});

router.post('/', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const schema = z.object({
    amount: z.coerce.number().positive(),
    payment_method: z.string().default('bank_transfer'),
    content: z.string().optional(),
    bank: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Dữ liệu nạp tiền không hợp lệ' });
  }

  const deposit = await prisma.deposit_transactions.create({
    data: {
      user_id: userId,
      amount: parsed.data.amount,
      payment_method: parsed.data.payment_method,
      content: parsed.data.content || '',
      bank: parsed.data.bank || '',
      transaction_id: `BE-${Date.now()}`,
      status: 'pending',
    },
  });

  return res.json({ success: true, data: deposit });
});

export default router;
