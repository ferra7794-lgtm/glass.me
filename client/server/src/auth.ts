import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import type { Request, Response, NextFunction } from 'express';
import { getSession } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

export function hashCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function newVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function createToken(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

export function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET) as { sub: string; sid: string };
}

export function authCookie(res: Response, token: string) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie('session');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = verifyToken(token);
    if (payload.sid) {
      const session = await getSession(payload.sid);
      if (!session || session.revokedAt) return res.status(401).json({ error: 'Session revoked' });
    }
    (req as any).userId = payload.sub;
    (req as any).sessionId = payload.sid;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

export function id(prefix: string) {
  return `${prefix}_${nanoid(12)}`;
}