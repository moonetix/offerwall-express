// Moonetix offerwall helpers. Server side only. No framework, no dependencies.
// Docs: https://docs.moonetix.com/offerwall-link and https://docs.moonetix.com/postbacks
import crypto from 'node:crypto';

export const WALL_BASE = 'https://wall.moonetix.com/';
export const MICRO = 1_000_000; // rewards are stored in millionths of a coin

const USER_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/;
const SUB_ID_RE = /^[A-Za-z0-9._~:@+-]{1,100}$/;
const AMOUNT_RE = /^([0-9]{1,12})(?:\.([0-9]{1,6}))?$/;
const PARAMS = ['tx', 'user', 'reward', 'status', 'hash'];

function required(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is not set`);
  return value;
}

// The signed offerwall link for one of YOUR user IDs. sub1 to sub5 are optional and not signed.
export function wallUrl({ appId, linkSalt }, userId, subs = {}) {
  const id = String(userId);
  if (!USER_ID_RE.test(id)) throw new Error('The user ID must be 1 to 100 characters from A-Z a-z 0-9 . _ @ : + -');
  const hash = crypto.createHmac('sha256', required(linkSalt, 'MOONETIX_LINK_SALT')).update(id).digest('hex');
  let url = `${WALL_BASE}${encodeURIComponent(required(appId, 'MOONETIX_APP_ID'))}?user_id=${encodeURIComponent(id)}&hash=${hash}`;
  for (const [key, value] of Object.entries(subs)) {
    if (/^sub[1-5]$/.test(key) && typeof value === 'string' && SUB_ID_RE.test(value)) {
      url += `&${key}=${encodeURIComponent(value)}`;
    }
  }
  return url;
}

// Reads the signed values exactly as they arrived. get(key) returns what the framework parsed.
// Anything that is not exactly one string (missing, or an array from a repeated key) gives null.
export function readParams(get) {
  const p = {};
  for (const key of PARAMS) {
    const value = get(key);
    if (typeof value !== 'string') return null;
    p[key] = value;
  }
  // Not signed. Kept for display only.
  const offer = get('offer');
  p.offer = typeof offer === 'string' ? offer.slice(0, 200) : '';
  return p;
}

// Constant-time check of the postback hash. Byte lengths are compared first,
// because crypto.timingSafeEqual throws on different lengths.
export function validHash(postbackKey, p) {
  const expected = Buffer.from(
    crypto.createHmac('sha256', required(postbackKey, 'MOONETIX_POSTBACK_KEY'))
      .update(`${p.tx}:${p.user}:${p.reward}:${p.status}`)
      .digest('hex'),
  );
  const given = Buffer.from(p.hash);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// "150" -> 150000000, "0.75" -> 750000. null for anything else. No floats.
export function toMicro(amount) {
  const m = AMOUNT_RE.exec(amount);
  if (!m) return null;
  return Number(m[1]) * MICRO + Number((m[2] || '').padEnd(6, '0'));
}

// 151984560 -> "151.98456"
export function formatMicro(micro) {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const frac = String(abs % MICRO).padStart(6, '0').replace(/0+$/, '');
  return sign + Math.floor(abs / MICRO) + (frac ? `.${frac}` : '');
}

// Handles one postback. Returns { code, body }. Only a stored change, or an event
// we deliberately skip, gets 200. A thrown error means the caller answers 500.
export function handlePostback(p, { postbackKey, store, log = () => {} }) {
  // 1. The hash first. Nothing else runs before this check.
  if (!p || !validHash(postbackKey, p)) return { code: 403, body: 'Invalid hash' };

  // 2. Signed values, now check their shape.
  const rewardMicro = toMicro(p.reward);
  if (p.tx === '' || p.tx.length > 191 || p.user.length > 100 || rewardMicro === null
    || (p.status !== '1' && p.status !== '2')) {
    return { code: 400, body: 'Bad parameters' };
  }

  // 3. Tests from the dashboard always have a transaction_id that starts with test_.
  if (p.tx.startsWith('test_')) {
    log('test postback: hash OK, nothing credited', { tx: p.tx, user: p.user, status: p.status });
    return { code: 200, body: 'Test postback: hash OK, nothing credited' };
  }

  // 4. Apply it in one database transaction. Errors propagate: the caller answers 500.
  const result = store.applyPostback({
    tx: p.tx, userId: p.user, rewardMicro, status: Number(p.status), offer: p.offer,
  });
  log('postback', { tx: p.tx, user: p.user, reward: p.reward, status: p.status, result });
  return { code: 200, body: result };
}
