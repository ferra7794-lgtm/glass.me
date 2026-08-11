import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_TOKEN,
});

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    emailVerified INTEGER DEFAULT 0,
    username TEXT UNIQUE,
    displayName TEXT,
    avatar TEXT,
    bio TEXT,
    passwordHash TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    codeHash TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL,
    lastSentAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    device TEXT,
    userAgent TEXT,
    ip TEXT,
    createdAt TEXT NOT NULL,
    lastSeenAt TEXT NOT NULL,
    revokedAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_members (
    chatId TEXT NOT NULL,
    userId TEXT NOT NULL,
    PRIMARY KEY (chatId, userId)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chatId TEXT NOT NULL,
    senderId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
];

export async function initDb() {
  if (!process.env.TURSO_URL) {
    throw new Error('TURSO_URL is not set — check your environment variables');
  }
  for (const sql of SCHEMA_STATEMENTS) {
    try {
      await db.execute(sql);
    } catch (err) {
      console.error('Failed statement:', sql);
      throw err;
    }
  }
}

// ── users ──────────────────────────────────────────────────────────────────
export async function findUserByEmail(email: string) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase()] });
  return r.rows[0] ?? null;
}

export async function findUserByUsername(username: string) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE LOWER(username) = ?', args: [username.toLowerCase()] });
  return r.rows[0] ?? null;
}

export async function findUserById(id: string) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  return r.rows[0] ?? null;
}

export async function isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
  const reserved = new Set(['admin', 'support', 'help', 'root', 'system', 'moderator', 'glassmessenger']);
  if (reserved.has(username.toLowerCase())) return true;
  const r = await db.execute({
    sql: 'SELECT id FROM users WHERE LOWER(username) = ? AND id != ?',
    args: [username.toLowerCase(), excludeUserId ?? '']
  });
  return r.rows.length > 0;
}

export async function createUser(user: { id: string; email: string; passwordHash?: string | null; createdAt: string; updatedAt: string }) {
  await db.execute({
    sql: 'INSERT INTO users (id, email, emailVerified, username, displayName, avatar, bio, passwordHash, createdAt, updatedAt) VALUES (?,?,0,NULL,NULL,NULL,NULL,?,?,?)',
    args: [user.id, user.email.toLowerCase(), user.passwordHash ?? null, user.createdAt, user.updatedAt]
  });
  return findUserById(user.id);
}

export async function updateUser(id: string, fields: Record<string, any>) {
  const keys = Object.keys(fields);
  const sql = `UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  await db.execute({ sql, args: [...Object.values(fields), id] });
  return findUserById(id);
}

export async function searchUsers(q: string) {
  const r = await db.execute({
    sql: `SELECT * FROM users WHERE emailVerified = 1 AND (LOWER(username) LIKE ? OR LOWER(displayName) LIKE ?) LIMIT 20`,
    args: [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`]
  });
  return r.rows;
}

// ── verification codes ─────────────────────────────────────────────────────
export async function getVerificationCode(email: string) {
  const r = await db.execute({
    sql: 'SELECT * FROM verification_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1',
    args: [email.toLowerCase()]
  });
  return r.rows[0] ?? null;
}

export async function upsertVerificationCode(code: { id: string; email: string; codeHash: string; expiresAt: string; createdAt: string; lastSentAt: string }) {
  await db.execute({ sql: 'DELETE FROM verification_codes WHERE email = ?', args: [code.email.toLowerCase()] });
  await db.execute({
    sql: 'INSERT INTO verification_codes (id, email, codeHash, expiresAt, attempts, createdAt, lastSentAt) VALUES (?,?,?,?,0,?,?)',
    args: [code.id, code.email.toLowerCase(), code.codeHash, code.expiresAt, code.createdAt, code.lastSentAt]
  });
}

export async function incrementVerificationAttempts(email: string) {
  await db.execute({ sql: 'UPDATE verification_codes SET attempts = attempts + 1 WHERE email = ?', args: [email.toLowerCase()] });
}

export async function deleteVerificationCode(email: string) {
  await db.execute({ sql: 'DELETE FROM verification_codes WHERE email = ?', args: [email.toLowerCase()] });
}

// ── sessions ───────────────────────────────────────────────────────────────
export async function createSession(session: { id: string; userId: string; device: string; userAgent: string; ip: string; createdAt: string; lastSeenAt: string }) {
  await db.execute({
    sql: 'INSERT INTO sessions (id, userId, device, userAgent, ip, createdAt, lastSeenAt, revokedAt) VALUES (?,?,?,?,?,?,?,NULL)',
    args: [session.id, session.userId, session.device, session.userAgent, session.ip, session.createdAt, session.lastSeenAt]
  });
}

export async function getActiveSessions(userId: string) {
  const r = await db.execute({
    sql: 'SELECT * FROM sessions WHERE userId = ? AND revokedAt IS NULL ORDER BY lastSeenAt DESC',
    args: [userId]
  });
  return r.rows;
}

export async function getSession(id: string) {
  const r = await db.execute({ sql: 'SELECT * FROM sessions WHERE id = ?', args: [id] });
  return r.rows[0] ?? null;
}

export async function revokeSession(id: string, userId: string, now: string) {
  await db.execute({ sql: 'UPDATE sessions SET revokedAt = ? WHERE id = ? AND userId = ?', args: [now, id, userId] });
}

export async function revokeOtherSessions(userId: string, currentSessionId: string, now: string) {
  await db.execute({
    sql: 'UPDATE sessions SET revokedAt = ? WHERE userId = ? AND id != ? AND revokedAt IS NULL',
    args: [now, userId, currentSessionId]
  });
}

// ── chats ──────────────────────────────────────────────────────────────────
export async function findChat(userId: string, otherId: string) {
  const r = await db.execute({
    sql: `SELECT c.id FROM chats c
          JOIN chat_members a ON a.chatId = c.id AND a.userId = ?
          JOIN chat_members b ON b.chatId = c.id AND b.userId = ?
          LIMIT 1`,
    args: [userId, otherId]
  });
  return (r.rows[0]?.id as string) ?? null;
}

export async function createChat(chatId: string, userId: string, otherId: string, now: string) {
  await db.execute({ sql: 'INSERT INTO chats (id, createdAt) VALUES (?,?)', args: [chatId, now] });
  await db.execute({ sql: 'INSERT INTO chat_members (chatId, userId) VALUES (?,?)', args: [chatId, userId] });
  await db.execute({ sql: 'INSERT INTO chat_members (chatId, userId) VALUES (?,?)', args: [chatId, otherId] });
}

export async function getUserChats(userId: string) {
  const r = await db.execute({
    sql: `SELECT c.id, c.createdAt,
            (SELECT userId FROM chat_members WHERE chatId = c.id AND userId != ? LIMIT 1) as otherId,
            (SELECT text FROM messages WHERE chatId = c.id ORDER BY createdAt DESC LIMIT 1) as lastMessage,
            (SELECT createdAt FROM messages WHERE chatId = c.id ORDER BY createdAt DESC LIMIT 1) as lastAt
          FROM chats c
          JOIN chat_members m ON m.chatId = c.id AND m.userId = ?
          ORDER BY COALESCE(lastAt, c.createdAt) DESC`,
    args: [userId, userId]
  });
  return r.rows;
}

export async function isChatMember(chatId: string, userId: string) {
  const r = await db.execute({ sql: 'SELECT 1 FROM chat_members WHERE chatId = ? AND userId = ?', args: [chatId, userId] });
  return r.rows.length > 0;
}

// ── messages ───────────────────────────────────────────────────────────────
export async function getChatMessages(chatId: string) {
  const r = await db.execute({ sql: 'SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC', args: [chatId] });
  return r.rows;
}

export async function createMessage(msg: { id: string; chatId: string; senderId: string; text: string; createdAt: string; updatedAt: string }) {
  await db.execute({
    sql: 'INSERT INTO messages (id, chatId, senderId, text, createdAt, updatedAt) VALUES (?,?,?,?,?,?)',
    args: [msg.id, msg.chatId, msg.senderId, msg.text, msg.createdAt, msg.updatedAt]
  });
}

// ── favorites ──────────────────────────────────────────────────────────────
export async function getFavorites(userId: string) {
  const r = await db.execute({ sql: 'SELECT * FROM favorites WHERE userId = ? ORDER BY updatedAt DESC', args: [userId] });
  return r.rows;
}

export async function createFavorite(fav: { id: string; userId: string; text: string; createdAt: string; updatedAt: string }) {
  await db.execute({
    sql: 'INSERT INTO favorites (id, userId, text, createdAt, updatedAt) VALUES (?,?,?,?,?)',
    args: [fav.id, fav.userId, fav.text, fav.createdAt, fav.updatedAt]
  });
  const r = await db.execute({ sql: 'SELECT * FROM favorites WHERE id = ?', args: [fav.id] });
  return r.rows[0];
}

export async function deleteFavorite(id: string, userId: string) {
  const r = await db.execute({ sql: 'DELETE FROM favorites WHERE id = ? AND userId = ?', args: [id, userId] });
  return r.rowsAffected > 0;
}