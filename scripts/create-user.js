// npm run create-user -- NAME
// Creates a demo user with a random password and prints it once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import { openStore } from '../src/store.js';

const username = process.argv[2];
if (!username || !/^[A-Za-z0-9._-]{1,50}$/.test(username)) {
  console.error('Usage: npm run create-user -- NAME   (letters, digits, . _ -)');
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH || './data/app.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
const store = openStore(dbPath);
if (store.findUserByName(username)) {
  console.error(`User ${username} already exists.`);
  process.exit(1);
}

const password = crypto.randomBytes(12).toString('base64url');
const id = store.createUser(username, hashPassword(password));
console.log(`User #${id}: ${username} / ${password}`);
