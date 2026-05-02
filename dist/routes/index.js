import { Router } from 'express';
import authRoutes from './auth.js';
import userRoutes from './users.js';
import depositRoutes from './deposits.js';
import smmRoutes from './smm.js';
import resourceRoutes from './resources.js';
import cardRoutes from './cards.js';
import forumRoutes from './forum.js';
import legacyRoutes from './legacy.js';
import proxyVendorRoutes from './proxy-vendor.js';
const router = Router();
router.get('/health', (_req, res) => {
    res.json({
        success: true,
        name: 'trungtammmo-be',
        time: new Date().toISOString(),
    });
});
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/deposits', depositRoutes);
router.use('/smm', smmRoutes);
router.use('/resources', resourceRoutes);
router.use('/cards', cardRoutes);
router.use('/forum', forumRoutes);
router.use('/legacy', legacyRoutes);
router.use('/proxy-vendor', proxyVendorRoutes);
export default router;
