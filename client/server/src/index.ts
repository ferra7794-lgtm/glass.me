import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { Server } from 'socket.io';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { authCookie, clearAuthCookie, createToken, hashCode, newVerificationCode, requireAuth, verifyToken } from './auth.js';
import { loadDb, saveDb, withDb } from './db.js';
import { mailEnabled, sendVerificationEmail } from './mailer.js';

const PORT = Number(process.env.SERVER_PORT || 3001);
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';
const APP_NAME = process.env.APP_NAME || 'Glass Messenger';
const TTL_MINUTES = Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES || 10);
const COOLDOWN = Number(process.env.EMAIL_RESEND_COOLDOWN_SECONDS || 60);
const MAX_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS || 5);
const MAX_AVATAR_MB = Number(process.env.MAX_AVATAR_MB || 5);
const UPLOAD_DIR = process.env.AVATAR_UPLOAD_DIR || './server/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: APP_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 180 }));

const server = createServer(app);
const io = new Server(server, { cors: { origin: APP_ORIGIN, credentials: true } });

const avatars = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_AVATAR_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype))
});

const emailSchema = z.string().email();
const usernameSchema = z.string().trim().regex(/^@?[a-zA-Z0-9_]{3,24}$/);
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  username: usernameSchema.optional(),
  bio: z.string().trim().max(160).optional()
});

function now() { return new Date().toISOString(); }
function uid(prefix: string) { return `${prefix}_${nanoid(12)}`; }
function publicUser(row: any) { return row ? ({ id: row.id, email: row.email, emailVerified: row.emailVerified, username: row.username, displayName: row.displayName, avatar: row.avatar, bio: row.bio, createdAt: row.createdAt, updatedAt: row.updatedAt }) : null; }

function parseDevice(ua: string) {
  const s = ua || '';
  let device = 'Неизвестное устройство';
  if (/iPhone/i.test(s)) device = 'iPhone';
  else if (/iPad/i.test(s)) device = 'iPad';
  else if (/Android/i.test(s)) device = 'Android';
  else if (/Macintosh/i.test(s)) device = 'Mac';
  else if (/Windows/i.test(s)) device = 'Windows';
  else if (/Linux/i.test(s)) device = 'Linux';
  let browser = '';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s)) browser = 'Safari';
  return browser ? `${device} · ${browser}` : device;
}

function createSession(req: any, userId: string) {
  return withDb(db => {
    const session = {
      id: uid('sess'),
      userId,
      device: parseDevice(req.headers['user-agent'] || ''),
      userAgent: req.headers['user-agent'] || '',
      ip: req.ip,
      createdAt: now(),
      lastSeenAt: now(),
      revokedAt: null as string | null
    };
    db.sessions.push(session);
    return session;
  });
}

// Reserved usernames that cannot be taken by any user
const RESERVED_USERNAMES = new Set(['admin', 'support', 'help', 'root', 'system', 'moderator', 'glassmessenger']);

function isUsernameTaken(normalizedUsername: string, excludeUserId?: string) {
  const lower = normalizedUsername.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) return true;
  const db = loadDb();
  return db.users.some(u => u.id !== excludeUserId && (u.username || '').toLowerCase() === lower);
}

function getCurrentUser(req: any) {
  const db = loadDb();
  return db.users.find(u => u.id === req.userId) || null;
}

function findUserByEmail(email: string) {
  const db = loadDb();
  return db.users.find(u => u.email === email.toLowerCase()) || null;
}

function findUserByUsername(username: string) {
  const db = loadDb();
  return db.users.find(u => u.username === username) || null;
}

function ensureChat(userId: string, otherId: string) {
  return withDb(db => {
    const existing = db.chats.find(chat => {
      const members = db.chat_members.filter(m => m.chatId === chat.id).map(m => m.userId);
      return members.includes(userId) && members.includes(otherId);
    });
    if (existing) return existing.id;
    const chatId = uid('chat');
    db.chats.push({ id: chatId, createdAt: now() });
    db.chat_members.push({ chatId, userId }, { chatId, userId: otherId });
    return chatId;
  });
}

function getChatMessages(chatId: string) {
  return loadDb().messages.filter(m => m.chatId === chatId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

app.post('/api/auth/start-register', rateLimit({ windowMs: 60_000, limit: 8 }), async (req, res) => {
  try {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const normalized = email.toLowerCase();
    if (findUserByEmail(normalized)?.emailVerified) return res.status(409).json({ error: 'Email already registered' });
    const db = loadDb();
    const recent = db.verification_codes.filter(v => v.email === normalized).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (recent && Date.now() - new Date(recent.lastSentAt).getTime() < COOLDOWN * 1000) return res.status(429).json({ error: 'Please wait before requesting a new code' });
    const code = newVerificationCode();
    const record = { id: uid('vc'), email: normalized, codeHash: hashCode(code), expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString(), attempts: 0, createdAt: now(), lastSentAt: now() };
    db.verification_codes = db.verification_codes.filter(v => v.email !== normalized);
    db.verification_codes.push(record);
    saveDb(db);
    await sendVerificationEmail(normalized, code);
    res.json({ ok: true, mailEnabled });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid email' });
  }
});

app.post('/api/auth/verify-code', rateLimit({ windowMs: 60_000, limit: 12 }), (req, res) => {
  try {
    const { email, code } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const normalized = email.toLowerCase();
    const db = loadDb();
    const row = db.verification_codes.filter(v => v.email === normalized).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!row) return res.status(400).json({ error: 'No verification code found' });
    if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    if (new Date(row.expiresAt).getTime() < Date.now()) return res.status(400).json({ error: 'Code expired. Request a new one.' });
    row.attempts += 1;
    saveDb(db);
    if (row.codeHash !== hashCode(code)) return res.status(400).json({ error: 'Invalid code' });
    const existing = findUserByEmail(normalized);
    const user = withDb(db2 => {
      const created = existing || { id: uid('user'), email: normalized, emailVerified: 1, username: null, displayName: null, avatar: null, bio: null, passwordHash: null, createdAt: now(), updatedAt: now() };
      if (!existing) db2.users.push(created);
      else Object.assign(existing, { emailVerified: 1, updatedAt: now() });
      db2.verification_codes = db2.verification_codes.filter(v => v.email !== normalized);
      return existing || created;
    });
    const session = createSession(req, user.id);
    const token = createToken(user.id, session.id);
    authCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid code' });
  }
});

app.post('/api/auth/email-login', rateLimit({ windowMs: 60_000, limit: 10 }), (req, res) => {
  try {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const normalized = email.toLowerCase();
    let user = findUserByEmail(normalized);
    if (!user) {
      user = withDb(db => {
        const created = { id: uid('user'), email: normalized, emailVerified: 1, username: null, displayName: null, avatar: null, bio: null, passwordHash: null, createdAt: now(), updatedAt: now() };
        db.users.push(created);
        return created;
      });
    }
    const session = createSession(req, user.id);
    const token = createToken(user.id, session.id);
    authCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid request' });
  }
});

app.post('/api/auth/login', rateLimit({ windowMs: 60_000, limit: 10 }), (req, res) => {
  try {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const user = findUserByEmail(email.toLowerCase());
    if (!user?.emailVerified) return res.status(400).json({ error: 'Email not verified' });
    const session = createSession(req, user.id);
    const token = createToken(user.id, session.id);
    authCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid request' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const sessionId = (req as any).sessionId;
  if (sessionId) withDb(db => { const s = db.sessions.find(x => x.id === sessionId); if (s) s.revokedAt = now(); });
  clearAuthCookie(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(getCurrentUser(req as any)) }));

app.get('/api/auth/sessions', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const currentSessionId = (req as any).sessionId;
  const sessions = loadDb().sessions
    .filter(s => s.userId === me && !s.revokedAt)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map(s => ({ id: s.id, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === currentSessionId }));
  res.json({ sessions });
});

app.post('/api/auth/sessions/:id/revoke', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const targetId = String(req.params.id);
  const db = loadDb();
  const session = db.sessions.find(s => s.id === targetId && s.userId === me);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.revokedAt = now();
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/auth/sessions/revoke-others', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const currentSessionId = (req as any).sessionId;
  const db = loadDb();
  db.sessions.filter(s => s.userId === me && s.id !== currentSessionId && !s.revokedAt).forEach(s => { s.revokedAt = now(); });
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '').toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = loadDb().users.filter(u => u.emailVerified && ((u.username || '').toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))).slice(0, 20).map(publicUser);
  res.json({ users });
});

app.get('/api/users/:username', requireAuth, (req, res) => {
  const username = String(req.params.username).replace(/^@/, '');
  const user = findUserByUsername(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

app.put('/api/profile', requireAuth, avatars.single('avatar'), (req, res) => {
  try {
    const me = getCurrentUser(req as any);
    const body = profileSchema.parse({
      displayName: typeof req.body.displayName === 'string' ? req.body.displayName : undefined,
      username: typeof req.body.username === 'string' ? req.body.username : undefined,
      bio: typeof req.body.bio === 'string' ? req.body.bio : undefined
    });
    const normalizedUsername = body.username?.replace(/^@/, '');
    if (normalizedUsername && isUsernameTaken(normalizedUsername, me.id)) return res.status(409).json({ error: 'Этот username уже занят' });
    const db = loadDb();
    let avatar = me.avatar;
    if (req.file) avatar = `/uploads/${req.file.filename}`;
    const user = db.users.find(u => u.id === me.id);
    Object.assign(user, { displayName: body.displayName ?? user.displayName, username: normalizedUsername ?? user.username, bio: body.bio ?? user.bio, avatar, updatedAt: now() });
    saveDb(db);
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid profile' });
  }
});

app.get('/api/favorites', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const items = loadDb().favorites.filter(f => f.userId === me).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ items });
});

app.post('/api/favorites', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).parse({ text: typeof req.body.text === 'string' ? req.body.text : '' });
  const item = withDb(db => {
    const created = { id: uid('fav'), userId: me, text: body.text, createdAt: now(), updatedAt: now() };
    db.favorites.push(created);
    return created;
  });
  res.json({ item });
});

app.delete('/api/favorites/:id', requireAuth, (req, res) => {
  const me = (req as any).userId;
  const targetId = String(req.params.id);
  const db = loadDb();
  const before = db.favorites.length;
  db.favorites = db.favorites.filter(f => !(f.id === targetId && f.userId === me));
  if (db.favorites.length === before) return res.status(404).json({ error: 'Not found' });
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/chats/open', requireAuth, (req, res) => {
  const { username } = z.object({ username: z.string().trim().min(1) }).parse(req.body);
  const me = getCurrentUser(req as any);
  const other = findUserByUsername(username.replace(/^@/, ''));
  if (!other) return res.status(404).json({ error: 'User not found' });
  const chatId = ensureChat(me.id, other.id);
  res.json({ chatId, other: publicUser(other), messages: getChatMessages(chatId) });
});

app.get('/api/chats', requireAuth, (req, res) => {
  const me = getCurrentUser(req as any);
  const db = loadDb();
  const chats = db.chats
    .filter(c => db.chat_members.some(m => m.chatId === c.id && m.userId === me.id))
    .map(chat => {
      const members = db.chat_members.filter(m => m.chatId === chat.id).map(m => m.userId);
      const otherId = members.find(id => id !== me.id) || me.id;
      const other = db.users.find(u => u.id === otherId);
      const last = db.messages.filter(m => m.chatId === chat.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { id: chat.id, createdAt: chat.createdAt, otherName: other?.displayName || other?.username || 'Private chat', otherUsername: other?.username || null, lastMessage: last?.text || '', lastAt: last?.createdAt || chat.createdAt };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  res.json({ chats });
});

app.get('/api/chats/:chatId/messages', requireAuth, (req, res) => {
  const me = getCurrentUser(req as any);
  const db = loadDb();
  const chatId = String(req.params.chatId);
  if (!db.chat_members.some(m => m.chatId === chatId && m.userId === me.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ messages: getChatMessages(chatId) });
});

app.post('/api/chats/:chatId/messages', requireAuth, (req, res) => {
  const me = getCurrentUser(req as any);
  const chatId = String(req.params.chatId);
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).parse({
    text: typeof req.body.text === 'string' ? req.body.text : ''
  });
  const db = loadDb();
  if (!db.chat_members.some(m => m.chatId === chatId && m.userId === me.id)) return res.status(403).json({ error: 'Forbidden' });
  const message = { id: uid('msg'), chatId, senderId: me.id, text: body.text, createdAt: now(), updatedAt: now() };
  db.messages.push(message);
  saveDb(db);
  io.to(chatId).emit('message:new', message);
  res.json({ message });
});

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist');
app.use(express.static(DIST));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err?.message || 'Server error' }));

io.on('connection', socket => {
  const token = socket.handshake.auth?.token || socket.handshake.headers.cookie?.match(/session=([^;]+)/)?.[1];
  if (!token) return socket.disconnect();
  try {
    verifyToken(token);
    socket.on('chat:join', (chatId: string) => socket.join(chatId));
  } catch {
    socket.disconnect();
  }
});

server.listen(PORT, () => console.log(`${APP_NAME} running on http://localhost:${PORT}`));