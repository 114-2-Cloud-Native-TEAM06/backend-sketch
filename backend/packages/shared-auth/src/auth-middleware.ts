import { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from './jwt.js';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export default function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Missing or invalid token' } });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Token expired or invalid' } });
  }
}
