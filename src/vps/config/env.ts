import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ENV_ROOT = process.cwd();
const ENV_FILES = [
  path.join(ENV_ROOT, ".env"),
  path.join(ENV_ROOT, ".env.local"),
  path.resolve(ENV_ROOT, "../FE/.env"),
  path.resolve(ENV_ROOT, "../FE/.env.local"),
];

for (const filename of ENV_FILES) {
  if (fs.existsSync(filename)) {
    dotenv.config({
      path: filename,
      override: false,
    });
  }
}

const rawEnv = {
  ...process.env,
  API_BASE_URL: process.env.API_BASE_URL || process.env.VPS_PORTAL_API_BASE_URL || "http://localhost:4000",
  JWT_SECRET:
    process.env.INTEGRATED_VPS_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    "please-change-this-secret-key",
  MYSQL_HOST: process.env.MYSQL_HOST || process.env.DB_HOST || "127.0.0.1",
  MYSQL_PORT: process.env.MYSQL_PORT || process.env.DB_PORT || "3306",
  MYSQL_USER: process.env.MYSQL_USER || process.env.DB_USER || "root",
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || process.env.DB_PASS || process.env.DB_PASSWORD || "",
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || process.env.DB_NAME || "trungt35_database",
  VNCLOUD_API_USERNAME:
    process.env.VNCLOUD_API_USERNAME ||
    process.env.VNCLOUD_AGENCY_API_USERNAME ||
    process.env.api_username ||
    "",
  VNCLOUD_API_PASSWORD:
    process.env.VNCLOUD_API_PASSWORD ||
    process.env.VNCLOUD_AGENCY_API_APP ||
    process.env.VNCLOUD_AGENCY_API_PASSWORD ||
    process.env.api_password ||
    "",
  VNCLOUD_API_TOKEN:
    process.env.VNCLOUD_API_TOKEN ||
    process.env.VNCLOUD_AGENCY_API_SECRET ||
    process.env.api_token ||
    "",
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  API_BASE_URL: z.string().url().default("http://localhost:8080"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  JWT_SECRET: z.string().min(16).default("please-change-this-secret-key"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_USER: z.string().default("root"),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_DATABASE: z.string().default("trungt35_database"),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
  PUBLIC_ASSET_BASE_URL: z.string().url().default("https://trungtammmo.vn"),
  VNCLOUD_BASE_URL: z.string().url().default("https://portal.vncloud.net"),
  VNCLOUD_API_USERNAME: z.string().default(""),
  VNCLOUD_API_PASSWORD: z.string().default(""),
  VNCLOUD_API_TOKEN: z.string().default(""),
  VNCLOUD_TOKEN_TIMEZONE: z.string().default("Asia/Ho_Chi_Minh"),
  VNCLOUD_TOKEN_ROTATION_HOURS: z.string().default("2,14"),
  VNCLOUD_TOKEN_CACHE_MINUTES: z.coerce.number().int().positive().default(830),
  VNCLOUD_TOKEN_REFRESH_AHEAD_MINUTES: z.coerce.number().int().positive().default(20),
});

export const env = envSchema.parse(rawEnv);
