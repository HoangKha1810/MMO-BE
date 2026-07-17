import { readFile } from "fs/promises";
import path from "path";
import { RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { pool } from "./pool.js";

const SCHEMA_FILE_PATH = path.resolve(process.cwd(), "database/vps_store_schema.sql");

function splitSqlStatements(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

type ColumnCheckRow = RowDataPacket & {
  COLUMN_NAME: string;
};

async function hasColumn(tableName: string, columnName: string) {
  const [rows] = await pool.query<ColumnCheckRow[]>(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [env.MYSQL_DATABASE, tableName, columnName],
  );

  return rows.length > 0;
}

async function ensureColumn(
  tableName: string,
  columnName: string,
  definition: string,
) {
  if (await hasColumn(tableName, columnName)) {
    return;
  }

  await pool.query(
    `ALTER TABLE \`${tableName}\`
     ADD COLUMN \`${columnName}\` ${definition}`,
  );
  console.log(`Đã bổ sung cột thiếu ${tableName}.${columnName}`);
}

async function ensureLegacySchemaCompatibility() {
  await ensureColumn(
    "vps_remote_billing_cycles",
    "months",
    "int NOT NULL DEFAULT 1 AFTER `label`",
  );
  await ensureColumn(
    "vps_orders",
    "addon_cpu",
    "int NOT NULL DEFAULT 0 AFTER `quantity`",
  );
  await ensureColumn(
    "vps_orders",
    "addon_ram",
    "int NOT NULL DEFAULT 0 AFTER `addon_cpu`",
  );
  await ensureColumn(
    "vps_orders",
    "addon_disk",
    "int NOT NULL DEFAULT 0 AFTER `addon_ram`",
  );
}

export async function bootstrapVpsStoreSchema() {
  const schemaContent = await readFile(SCHEMA_FILE_PATH, "utf8");
  const statements = splitSqlStatements(schemaContent);

  for (const statement of statements) {
    await pool.query(statement);
  }

  await ensureLegacySchemaCompatibility();
}
