import { prisma } from './prisma.js';

const tableCache = new Map<string, boolean>();

export async function tableExists(table: string) {
  if (tableCache.has(table)) {
    return tableCache.get(table) || false;
  }

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `
        SELECT TABLE_NAME AS table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?
        LIMIT 1
      `,
      table
    );
    const exists = rows.length > 0;
    tableCache.set(table, exists);
    return exists;
  } catch {
    tableCache.set(table, false);
    return false;
  }
}
