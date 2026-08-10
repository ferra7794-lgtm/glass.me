import fs from 'node:fs';
import path from 'node:path';

export type DbState = {
  users: any[];
  verification_codes: any[];
  chats: any[];
  chat_members: any[];
  messages: any[];
  sessions: any[];
  favorites: any[];
};

const dbPath = process.env.DATABASE_PATH || './server/data/app.db.json';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const empty: DbState = { users: [], verification_codes: [], chats: [], chat_members: [], messages: [], sessions: [], favorites: [] };

export function loadDb(): DbState {
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) };
  } catch {
    return structuredClone(empty);
  }
}

export function saveDb(state: DbState) {
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
}

export function withDb<T>(fn: (db: DbState) => T): T {
  const state = loadDb();
  const result = fn(state);
  saveDb(state);
  return result;
}
