import fs from 'node:fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';
import routes from './routes/index.js';

dotenv.config();

const legacyEnvPath = process.env.LEGACY_PHP_ENV_PATH?.trim() || '/Users/hkha/Downloads/vscode/.env';
if (fs.existsSync(legacyEnvPath)) {
  dotenv.config({
    path: legacyEnvPath,
    override: false,
  });
}

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) || true,
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.use('/api', routes);

  return app;
}
