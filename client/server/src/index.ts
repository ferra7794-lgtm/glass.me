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
import { mailEnabled, sendVerificationEmail } from './mailer.js';
import {
  initDb,
  findUserByEmail, findUserByUsername, findUserById, isUsernameTaken, createUser, updateUser, searchUsers,
  getVerificationCode, upsertVerificationCode, incrementVerificationAttempts, deleteVerificationCode,
  createSession as dbCreateSession, getActiveSessions, getSession, revokeSession, revokeOtherSessions,
  findChat, createChat, getUserChats, isChatMember,
  getChatMessages, createMessage,
  getFavorites, createFavorite, deleteFavorite
} from './db.js';

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3001);
const APP_ORIGIN = (process.env.APP_ORIGIN || 'http://localhost:5173').trim().replace(/\/$/, '');
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

function nowStr() { return new Date().toISOString(); }
function uid(prefix: string) { return `${prefix}_${nanoid(12)}`; }
function publicUser(row: any) {
  return row ? ({
    id: row.id, email: row.email, emailVerified: row.emailVerified,
    username: row.username, displayName: row.displayName, avatar: row.avatar,
    bio: row.bio, hasPassword: !!row.passwordHash, createdAt: row.createdAt, updatedAt: row.updatedAt
  }) : null;
}

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

async function makeSession(req: any, userId: string) {
  const session = {
    id: uid('sess'),
    userId,
    device: parseDevice(req.headers['user-agent'] || ''),
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip,
    createdAt: nowStr(),
    lastSeenAt: nowStr()
  };
  await dbCreateSession(session);
  return session;
}

// ── AUTH ───────────────────────────────────────────────────────────────────

app.post('/api/auth/email-login', rateLimit({ windowMs: 60_000, limit: 10 }), async (req, res) => {
  try {
    const { email, password } = z.object({ email: emailSchema, password: z.string().min(8).max(72) }).parse(req.body);
    const normalized = email.toLowerCase();
    let user = await findUserByEmail(normalized) as any;
    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10);
      user = await createUser({ id: uid('user'), email: normalized, passwordHash, createdAt: nowStr(), updatedAt: nowStr() });
    } else if (user.passwordHash) {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
    }
    const session = await makeSession(req, user.id);
    const token = createToken(user.id, session.id);
    authCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid request' });
  }
});

app.post('/api/auth/set-password', requireAuth, async (req, res) => {
  try {
    const me = await findUserById((req as any).userId) as any;
    if (me.passwordHash) return res.status(409).json({ error: 'Пароль уже задан, изменить его нельзя' });
    const { password } = z.object({ password: z.string().min(8).max(72) }).parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await updateUser(me.id, { passwordHash, updatedAt: nowStr() });
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Не удалось сохранить пароль' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const sessionId = (req as any).sessionId;
  if (sessionId) await revokeSession(sessionId, (req as any).userId, nowStr());
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await findUserById((req as any).userId);
  res.json({ user: publicUser(user) });
});

app.get('/api/auth/sessions', requireAuth, async (req, res) => {
  const me = (req as any).userId;
  const currentSessionId = (req as any).sessionId;
  const sessions = (await getActiveSessions(me)).map((s: any) => ({
    id: s.id, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === currentSessionId
  }));
  res.json({ sessions });
});

app.post('/api/auth/sessions/:id/revoke', requireAuth, async (req, res) => {
  const me = (req as any).userId;
  const session = await getSession(String(req.params.id));
  if (!session || session.userId !== me) return res.status(404).json({ error: 'Session not found' });
  await revokeSession(String(req.params.id), me, nowStr());
  res.json({ ok: true });
});

app.post('/api/auth/sessions/revoke-others', requireAuth, async (req, res) => {
  await revokeOtherSessions((req as any).userId, (req as any).sessionId, nowStr());
  res.json({ ok: true });
});

// ── USERS ──────────────────────────────────────────────────────────────────

app.get('/api/users/check-username', requireAuth, async (req, res) => {
  const raw = String(req.query.username || '').trim().replace(/^@/, '');
  if (!raw) return res.json({ available: false, error: 'Введите username' });
  const parsed = usernameSchema.safeParse(raw);
  if (!parsed.success) return res.json({ available: false, error: 'Только латиница, цифры и _ (3–24 символа)' });
  const taken = await isUsernameTaken(raw, (req as any).userId);
  res.json({ available: !taken, error: taken ? 'Уже занят' : null });
});

app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [] });
  const users = (await searchUsers(q)).map(publicUser);
  res.json({ users });
});

app.get('/api/users/:username', requireAuth, async (req, res) => {
  const user = await findUserByUsername(String(req.params.username).replace(/^@/, ''));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

// ── PROFILE ────────────────────────────────────────────────────────────────

app.put('/api/profile', requireAuth, avatars.single('avatar'), async (req, res) => {
  try {
    const me = await findUserById((req as any).userId) as any;
    const body = profileSchema.parse({
      displayName: typeof req.body.displayName === 'string' ? req.body.displayName : undefined,
      username: typeof req.body.username === 'string' ? req.body.username : undefined,
      bio: typeof req.body.bio === 'string' ? req.body.bio : undefined
    });
    const normalizedUsername = body.username?.replace(/^@/, '');
    if (normalizedUsername && await isUsernameTaken(normalizedUsername, me.id)) {
      return res.status(409).json({ error: 'Этот username уже занят' });
    }
    const avatar = req.file ? `/uploads/${req.file.filename}` : me.avatar;
    const fields: Record<string, any> = { updatedAt: nowStr() };
    if (body.displayName !== undefined) fields.displayName = body.displayName;
    if (normalizedUsername !== undefined) fields.username = normalizedUsername;
    if (body.bio !== undefined) fields.bio = body.bio;
    if (avatar !== me.avatar) fields.avatar = avatar;
    if (!me.emailVerified) fields.emailVerified = 1;
    const user = await updateUser(me.id, fields);
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Invalid profile' });
  }
});

// ── FAVORITES ──────────────────────────────────────────────────────────────

app.get('/api/favorites', requireAuth, async (req, res) => {
  const items = await getFavorites((req as any).userId);
  res.json({ items });
});

app.post('/api/favorites', requireAuth, async (req, res) => {
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).parse({ text: typeof req.body.text === 'string' ? req.body.text : '' });
  const item = await createFavorite({ id: uid('fav'), userId: (req as any).userId, text: body.text, createdAt: nowStr(), updatedAt: nowStr() });
  res.json({ item });
});

app.delete('/api/favorites/:id', requireAuth, async (req, res) => {
  const found = await deleteFavorite(String(req.params.id), (req as any).userId);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── CHATS ──────────────────────────────────────────────────────────────────

app.post('/api/chats/open', requireAuth, async (req, res) => {
  const { username } = z.object({ username: z.string().trim().min(1) }).parse(req.body);
  const me = await findUserById((req as any).userId) as any;
  const other = await findUserByUsername(username.replace(/^@/, '')) as any;
  if (!other) return res.status(404).json({ error: 'User not found' });
  let chatId = await findChat(me.id, other.id);
  if (!chatId) {
    chatId = uid('chat');
    await createChat(chatId, me.id, other.id, nowStr());
  }
  const messages = await getChatMessages(chatId);
  res.json({ chatId, other: publicUser(other), messages });
});

app.get('/api/chats', requireAuth, async (req, res) => {
  const me = (req as any).userId;
  const rows = await getUserChats(me);
  const chats = await Promise.all(rows.map(async (row: any) => {
    const other = row.otherId ? await findUserById(row.otherId) as any : null;
    return {
      id: row.id,
      createdAt: row.createdAt,
      otherName: other?.displayName || other?.username || 'Private chat',
      otherUsername: other?.username || null,
      lastMessage: row.lastMessage || '',
      lastAt: row.lastAt || row.createdAt
    };
  }));
  res.json({ chats });
});

app.get('/api/chats/:chatId/messages', requireAuth, async (req, res) => {
  const chatId = String(req.params.chatId);
  if (!await isChatMember(chatId, (req as any).userId)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ messages: await getChatMessages(chatId) });
});

app.post('/api/chats/:chatId/messages', requireAuth, async (req, res) => {
  const chatId = String(req.params.chatId);
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).parse({ text: typeof req.body.text === 'string' ? req.body.text : '' });
  if (!await isChatMember(chatId, (req as any).userId)) return res.status(403).json({ error: 'Forbidden' });
  const message = { id: uid('msg'), chatId, senderId: (req as any).userId, text: body.text, createdAt: nowStr(), updatedAt: nowStr() };
  await createMessage(message);
  io.to(chatId).emit('message:new', message);
  res.json({ message });
});

// ── STATIC + SOCKET ────────────────────────────────────────────────────────

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

initDb().then(() => {
  server.listen(PORT, () => console.log(`${APP_NAME} running on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});