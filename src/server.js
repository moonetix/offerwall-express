import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { openStore } from './store.js';

const env = process.env;
const missing = ['MOONETIX_APP_ID', 'MOONETIX_LINK_SALT', 'MOONETIX_POSTBACK_KEY', 'SESSION_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in .env or the environment.`);
  process.exit(1);
}

const dbPath = env.DATABASE_PATH || './data/app.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

const config = {
  appId: env.MOONETIX_APP_ID,
  linkSalt: env.MOONETIX_LINK_SALT,
  postbackKey: env.MOONETIX_POSTBACK_KEY,
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.NODE_ENV === 'production',
};

const app = createApp({
  config,
  store: openStore(dbPath),
  log: (msg, data) => console.log(`moonetix: ${msg}`, JSON.stringify(data)),
});

const port = Number(env.PORT || 3000);
const host = env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));
