import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DATABASE_PATH || './server/data/app.db.json';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
console.log(`Removed ${dbPath}`);
