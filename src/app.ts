import fs from 'node:fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';
import routes from './routes/index.js';
import gameApiProxyRoutes from './routes/game-api-proxy.js';
import { securityGuard, securityHeaders } from './lib/security.js';
import { createVpsRouter, startIntegratedVpsBackend } from './vps/index.js';

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
  const corsOrigins = String(process.env.CORS_ORIGIN || process.env.APP_URL || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('CORS origin blocked'));
      },
      credentials: true,
    })
  );
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(securityGuard);
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.use('/api/external/game', gameApiProxyRoutes);
  app.use('/', gameApiProxyRoutes);
  app.use('/api/vps', createVpsRouter());
  app.use('/api', routes);

  void startIntegratedVpsBackend();

  return app;
}
