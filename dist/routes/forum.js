import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
const router = Router();
router.get('/categories', async (_req, res) => {
    const categories = await prisma.$queryRawUnsafe(`
    SELECT id, name, description, priority, created_at
    FROM forum_categories
    ORDER BY priority ASC, id ASC
  `).catch(() => []);
    return res.json({ success: true, data: categories });
});
router.get('/threads', async (_req, res) => {
    const rows = await prisma.$queryRawUnsafe(`
    SELECT
      t.id,
      t.user_id,
      t.forum_id,
      t.title,
      t.slug,
      t.views,
      t.is_pinned,
      t.is_locked,
      t.status,
      t.created_at,
      t.updated_at,
      COALESCE(fp.content, '') AS content,
      COALESCE(reply_counts.replies, 0) AS replies,
      f.name AS forum_name,
      f.slug AS forum_slug,
      c.name AS category_name,
      u.username,
      u.avatar,
      u.rank
    FROM forum_threads t
    LEFT JOIN forums f ON f.id = t.forum_id
    LEFT JOIN forum_categories c ON c.id = f.category_id
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN forum_posts fp ON fp.id = (
      SELECT p.id
      FROM forum_posts p
      WHERE p.thread_id = t.id
        AND p.is_first_post = 1
        AND COALESCE(p.is_deleted, 0) = 0
      ORDER BY p.id ASC
      LIMIT 1
    )
    LEFT JOIN (
      SELECT thread_id, COUNT(*) AS replies
      FROM forum_posts
      WHERE is_first_post = 0
        AND status = 'active'
        AND COALESCE(is_deleted, 0) = 0
      GROUP BY thread_id
    ) reply_counts ON reply_counts.thread_id = t.id
    WHERE t.status = 'active'
      AND COALESCE(t.is_deleted, 0) = 0
    ORDER BY t.is_pinned DESC, t.updated_at DESC, t.created_at DESC
    LIMIT 50
  `).catch(() => []);
    const threads = rows.map((thread) => ({
        ...thread,
        id: Number(thread.id || 0),
        user_id: Number(thread.user_id || 0),
        forum_id: Number(thread.forum_id || 0),
        views: Number(thread.views || 0),
        replies: Number(thread.replies || 0),
    }));
    return res.json({ success: true, data: threads });
});
export default router;
