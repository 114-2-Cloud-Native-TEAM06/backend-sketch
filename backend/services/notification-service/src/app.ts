import 'express-async-errors';
import express, { Express } from 'express';
import { errorMiddleware } from '../../../packages/shared-errors/src/error-middleware.js';

export function createNotificationServiceApp(): Express {
  const app: Express = express();
  app.disable('x-powered-by'); // don't leak framework/version info
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(errorMiddleware);
  return app;
}
