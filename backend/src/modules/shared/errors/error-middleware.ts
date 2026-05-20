import type { Request, Response, NextFunction } from 'express';
import { AppError, raiseApiError } from './app-error.js';

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

  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json(raiseApiError('INTERNAL', 'Internal server error'));
}
