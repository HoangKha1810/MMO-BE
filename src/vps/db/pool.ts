import mysql, {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { env } from "../config/env.js";

export const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: env.MYSQL_CONNECTION_LIMIT,
  namedPlaceholders: false,
  decimalNumbers: true,
});

export async function queryRows<T extends RowDataPacket[]>(
  sql: string,
  params: unknown[] = [],
) {
  const [rows] = await pool.query<T>(sql, params);
  return rows;
}

export function isMissingTableError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ER_NO_SUCH_TABLE"
  );
}

export function isMissingColumnError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ER_BAD_FIELD_ERROR"
  );
}

export function isSchemaCompatibilityError(error: unknown) {
  return isMissingTableError(error) || isMissingColumnError(error);
}

export async function queryRowsOrFallback<T extends RowDataPacket[]>(
  sql: string,
  params: unknown[] = [],
  fallback: T,
) {
  try {
    return await queryRows<T>(sql, params);
  } catch (error) {
    if (isMissingTableError(error)) {
      return fallback;
    }

    throw error;
  }
}

export async function executeResult(
  sql: string,
  params: any[] = [],
) {
  const [result] = await pool.execute<ResultSetHeader>(sql, params);
  return result;
}

export async function withTransaction<T>(
  handler: (connection: PoolConnection) => Promise<T>,
) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
