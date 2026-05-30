import type { Request, Response, NextFunction } from 'express';
import { AppError, raiseApiError } from './app-error.js';
import { logger } from '../observability/logger.js';

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(raiseApiError(err.code, err.message));
    return;
  }

  logger.error({ err, method: req.method, url: req.originalUrl }, 'unhandled request error');
  res.status(500).json(raiseApiError('INTERNAL', 'Internal server error'));
}
