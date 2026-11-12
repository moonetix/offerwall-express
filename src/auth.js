// Demo sign-in so the example runs on its own: scrypt password hashes and an
// HMAC-signed session cookie. In your app, keep your own authentication and
// pass the signed-in user's ID to wallUrl().
import crypto from 'node:crypto';

const COOKIE = 'sid';
const MAX_AGE_S = 7 * 24 * 3600;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(secret, userId, secure) {
  const value = `${userId}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
  return `${COOKIE}=${value}.${sign(secret, value)}; ${flags}`;
}

export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// The user ID from a valid, unexpired session cookie, or null.
export function sessionUserId(secret, cookieHeader) {
  const raw = readCookie(cookieHeader, COOKIE);
  const m = raw && /^([1-9][0-9]{0,14})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!m) return null;
  const given = Buffer.from(m[3]);
  const wanted = Buffer.from(sign(secret, `${m[1]}.${m[2]}`));
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
  if (Number(m[2]) < Date.now() / 1000) return null;
  return Number(m[1]);
}
