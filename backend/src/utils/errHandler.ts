import { Request, Response, NextFunction } from 'express';
import { ErrorCode, ApiError } from '../types/api-types.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function raiseApiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApiError {
  return {
    error: {
      code,
      message,
      ...(details && { details })
    }
  };
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(raiseApiError(err.code, err.message));
    return;
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json(raiseApiError('INTERNAL', 'Internal server error'));
}