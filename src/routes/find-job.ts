import { Router } from 'express';
import { getUserId } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();
const columnCache = new Map<string, Set<string>>();

type Row = Record<string, unknown>;
type FindJobTable = 'find_job_jobs' | 'find_jobs';

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeOptionalNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOptionalInt(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function tableExists(table: string) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(`SHOW TABLES LIKE ?`, table).catch(() => []);
  return rows.length > 0;
}

async function resolveFindJobTable(): Promise<FindJobTable> {
  return (await tableExists('find_job_jobs')) ? 'find_job_jobs' : 'find_jobs';
}

async function getTableColumns(table: string) {
  const cached = columnCache.get(table);
  if (cached) return cached;

  const rows = await prisma.$queryRawUnsafe<Array<{ Field: string }>>(`SHOW COLUMNS FROM \`${table}\``);
  const columns = new Set(rows.map((row) => row.Field));
  columnCache.set(table, columns);
  return columns;
}

async function ensureFindJobColumns(table: FindJobTable) {
  const columns = await getTableColumns(table);
  const updates: string[] = [];

  if (!columns.has('is_pinned')) {
    updates.push('ADD COLUMN `is_pinned` TINYINT(1) NOT NULL DEFAULT 0 AFTER `status`');
  }

  if (!columns.has('approval_status')) {
    updates.push("ADD COLUMN `approval_status` VARCHAR(20) NOT NULL DEFAULT 'pending' AFTER `status`");
  }

  if (updates.length) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` ${updates.join(', ')}`);
    columnCache.delete(table);
  }
}

async function insertFiltered(table: string, data: Row) {
  const columns = await getTableColumns(table);
  const fields = Object.keys(data).filter((field) => columns.has(field));
  if (!fields.length) {
    throw new Error('Không có field hợp lệ để tạo tin');
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO \`${table}\` (${fields.map((field) => `\`${field}\``).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    ...fields.map((field) => data[field])
  );
}

async function updateFiltered(table: string, id: number, userField: 'posted_by' | 'user_id', userId: number, data: Row) {
  const columns = await getTableColumns(table);
  const fields = Object.keys(data).filter((field) => columns.has(field));
  if (!fields.length) {
    throw new Error('Không có field hợp lệ để cập nhật tin');
  }

  await prisma.$executeRawUnsafe(
    `UPDATE \`${table}\` SET ${fields.map((field) => `\`${field}\` = ?`).join(', ')} WHERE id = ? AND \`${userField}\` = ?`,
    ...fields.map((field) => data[field]),
    id,
    userId
  );
}

async function createOrUpdateFindJob(userId: number, body: Row) {
  const table = await resolveFindJobTable();
  await ensureFindJobColumns(table);

  const action = String(body.action || 'create').trim().toLowerCase();
  const jobId = Number(body.job_id || body.id || 0);
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const category = String(body.category || 'general').trim() || 'general';

  if (title.length < 8 || description.length < 20) {
    throw new Error('Tiêu đề hoặc mô tả quá ngắn');
  }

  if (table === 'find_job_jobs') {
    if (action === 'update') {
      await updateFiltered('find_job_jobs', jobId, 'posted_by', userId, {
        title,
        description,
        category,
        price_min: normalizeOptionalNumber(body.price_min),
        price_max: normalizeOptionalNumber(body.price_max),
        deadline_days: normalizeOptionalInt(body.deadline_days),
        status: 'pending',
        approval_status: 'pending',
        updated_at: new Date(),
      });
      return { id: jobId };
    }

    const now = new Date();
    await insertFiltered('find_job_jobs', {
      title,
      slug: `${slugify(title)}-${Date.now()}`,
      description,
      category,
      budget_type: 'fixed',
      price_min: normalizeOptionalNumber(body.price_min),
      price_max: normalizeOptionalNumber(body.price_max),
      deadline_days: normalizeOptionalInt(body.deadline_days),
      posted_by: userId,
      posted_at: now,
      status: 'pending',
      approval_status: 'pending',
      updated_at: now,
    });
  } else {
    if (action === 'update') {
      await updateFiltered('find_jobs', jobId, 'user_id', userId, {
        title,
        description,
        category,
        budget_min: normalizeOptionalNumber(body.price_min),
        budget_max: normalizeOptionalNumber(body.price_max),
        status: 'pending',
        approval_status: 'pending',
        updated_at: new Date(),
      });
      return { id: jobId };
    }

    const now = new Date();
    await insertFiltered('find_jobs', {
      user_id: userId,
      title,
      description,
      category,
      budget_min: normalizeOptionalNumber(body.price_min),
      budget_max: normalizeOptionalNumber(body.price_max),
      status: 'pending',
      approval_status: 'pending',
      created_at: now,
      updated_at: now,
    });
  }

  const inserted = await prisma.$queryRawUnsafe<Array<{ id: number | bigint }>>('SELECT LAST_INSERT_ID() AS id');
  return { id: Number(inserted[0]?.id || 0) };
}

router.post('/jobs', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const action = String(req.body?.action || 'create').trim().toLowerCase();
    const jobId = Number(req.body?.job_id || req.body?.id || 0);
    const table = await resolveFindJobTable();
    await ensureFindJobColumns(table);

    if (action === 'delete') {
      if (!jobId) {
        return res.status(400).json({ success: false, message: 'Thiếu job ID' });
      }

      await prisma.$executeRawUnsafe(
        table === 'find_job_jobs'
          ? 'UPDATE `find_job_jobs` SET status = ?, updated_at = NOW() WHERE id = ? AND posted_by = ?'
          : 'UPDATE `find_jobs` SET status = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        'closed',
        jobId,
        userId
      );
      return res.json({ success: true, message: 'Đã đóng tin tuyển dụng', data: { id: jobId } });
    }

    const data = await createOrUpdateFindJob(userId, req.body || {});
    return res.json({
      success: true,
      message: action === 'update'
        ? 'Đã cập nhật tin tuyển dụng, vui lòng chờ admin duyệt lại.'
        : 'Đã tạo tin tuyển dụng, vui lòng chờ admin duyệt trước khi hiển thị công khai.',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Không tạo được tin tuyển dụng',
    });
  }
});

router.post('/apply', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const table = await resolveFindJobTable();
    const jobId = Number(req.body?.job_id || 0);
    if (!jobId) {
      return res.status(400).json({ success: false, message: 'Thiếu job ID' });
    }

    const ownerRows = await prisma.$queryRawUnsafe<Array<{ owner_id: number | bigint }>>(
      table === 'find_job_jobs'
        ? 'SELECT posted_by AS owner_id FROM `find_job_jobs` WHERE id = ? LIMIT 1'
        : 'SELECT user_id AS owner_id FROM `find_jobs` WHERE id = ? LIMIT 1',
      jobId
    );

    if (!ownerRows.length) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tin tuyển dụng' });
    }

    if (Number(ownerRows[0]?.owner_id || 0) === userId) {
      return res.status(400).json({ success: false, message: 'Bạn không thể tự ứng tuyển tin của chính mình' });
    }

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO find_job_applications (job_id, applicant_id, applied_at, status)
        VALUES (?, ?, NOW(), 'pending')
        ON DUPLICATE KEY UPDATE applied_at = VALUES(applied_at)
      `,
      jobId,
      userId
    );

    await prisma.$executeRawUnsafe(
      'UPDATE `find_job_jobs` SET application_count = (SELECT COUNT(*) FROM find_job_applications WHERE job_id = ?) WHERE id = ?',
      jobId,
      jobId
    ).catch(() => undefined);

    return res.json({ success: true, message: 'Đã gửi ứng tuyển' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Không thể ứng tuyển',
    });
  }
});

router.post('/report', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const jobId = Number(req.body?.job_id || 0);
    const reason = String(req.body?.reason || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!jobId || reason.length < 3) {
      return res.status(400).json({ success: false, message: 'Thiếu job hoặc lý do report' });
    }

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO find_job_reports (job_id, reporter_id, reason, note, created_at, admin_processed)
        VALUES (?, ?, ?, ?, NOW(), 0)
      `,
      jobId,
      userId,
      reason.slice(0, 255),
      note.slice(0, 2000)
    );

    return res.json({ success: true, message: 'Đã gửi report cho admin' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Không thể gửi report',
    });
  }
});

export default router;
