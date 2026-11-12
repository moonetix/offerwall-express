// Starts the app on a random port with an in-memory database and replays postbacks
// that the Moonetix postback code produced and signed (fixtures/moonetix-vectors.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { formatMicro } from '../src/moonetix.js';
import { openStore } from '../src/store.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/moonetix-vectors.json', import.meta.url)));
const PB = V.postbacks;

let server;
let base;
let store;
const config = {
  appId: V.app_id,
  linkSalt: V.link_salt,
  postbackKey: V.postback_key,
  sessionSecret: 'test_session_secret_not_secret',
  secureCookies: false,
};

before(async () => {
  // A proxy object lets each test swap in a fresh database without restarting the server.
  const app = createApp({ config, store: new Proxy({}, { get: (_, k) => store[k] }) });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  store = openStore(':memory:');
  store.createUser('one', hashPassword('right-password')); // id 1
  store.createUser('two', hashPassword('x')); // id 2
});

const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init });
const balance = (id) => formatMicro(store.findUserById(id).balance_micro);
const txCount = () => store.db.prepare('SELECT COUNT(*) AS n FROM moonetix_transactions').get().n;

async function ok(path, text) {
  const res = await get(path);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.match(body, new RegExp(text));
  return res;
}

async function signIn(username = 'one', password = 'right-password') {
  const res = await get('/login', {
    method: 'POST',
    body: new URLSearchParams({ username, password }),
  });
  const cookie = res.headers.get('set-cookie');
  return { res, cookie: cookie ? cookie.split(';')[0] : null };
}

describe('postback', () => {
  test('a credit is applied once', async () => {
    await ok(PB.credit_150, 'Credited');
    assert.equal(balance(1), '150');
    await ok(PB.credit_150, 'Already processed');
    assert.equal(balance(1), '150');
    const row = store.db.prepare('SELECT * FROM moonetix_transactions WHERE transaction_id = ?').get('tx_1001');
    assert.equal(row.wall_user_id, '1');
    assert.equal(row.status, 1);
    assert.equal(row.offer_name, 'Bigo Live & "Friends"');
  });

  test('decimal and large rewards add up exactly', async () => {
    for (const name of ['credit_150', 'credit_decimal', 'credit_five_decimals', 'credit_user2', 'credit_large']) {
      await ok(PB[name], 'Credited');
    }
    assert.equal(balance(1), '151.98456');
    assert.equal(balance(2), '1234607.125');
  });

  test('a reversal takes back exactly what was credited, once', async () => {
    await ok(PB.credit_150, 'Credited');
    await ok(PB.credit_decimal, 'Credited');
    await ok(PB.reverse_150, 'Reversed');
    assert.equal(balance(1), '0.75');
    await ok(PB.reverse_150, 'Already processed');
    await ok(PB.credit_150, 'Already processed');
    assert.equal(balance(1), '0.75');
  });

  test('a reversal can take the balance below zero', async () => {
    await ok(PB.credit_150, 'Credited');
    store.db.prepare('UPDATE users SET balance_micro = 50000000 WHERE id = 1').run();
    await ok(PB.reverse_150, 'Reversed');
    assert.equal(balance(1), '-100');
  });

  test('a reversal without a credit changes nothing and blocks a late credit', async () => {
    await ok(PB.reverse_never_credited, 'Not credited before');
    await ok(PB.late_credit_after_reverse, 'Already processed');
    assert.equal(balance(1), '0');
  });

  test('dashboard test postbacks are verified but not credited', async () => {
    await ok(PB.test_credit, 'Test postback');
    await ok(PB.test_reverse, 'Test postback');
    assert.equal(balance(1), '0');
    assert.equal(txCount(), 0);
  });

  test('unknown users get 200 and nothing is stored', async () => {
    await ok(PB.unknown_user, 'Unknown user');
    await ok(PB.not_an_account_id, 'Unknown user');
    assert.equal(txCount(), 0);
  });

  test('the same credit sent 10 times at once is paid once', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => get(PB.credit_150).then((r) => r.status)));
    assert.deepEqual([...new Set(results)], [200]);
    assert.equal(balance(1), '150');
  });

  test('a wrong key is rejected', async () => {
    assert.equal((await get(PB.wrong_key)).status, 403);
    assert.equal(balance(1), '0');
  });

  test('tampered values are rejected', async () => {
    for (const [from, to] of [['reward=150&', 'reward=1500&'], ['user=1&', 'user=2&'], ['tx=tx_1001&', 'tx=tx_1002&'], ['status=1&', 'status=2&']]) {
      assert.equal((await get(PB.credit_150.replace(from, to))).status, 403, to);
    }
    assert.equal(balance(1), '0');
    assert.equal(balance(2), '0');
  });

  test('malformed requests are rejected', async () => {
    const url = PB.credit_150;
    const hash = url.split('hash=')[1];
    for (const path of [
      url.replace(hash, hash.toUpperCase()),
      url.replace(`&hash=${hash}`, ''),
      `${url}&hash=${hash}`,
      url.replace('tx=tx_1001&', 'tx=tx_1001&tx=tx_1001&'),
      '/moonetix/postback',
    ]) {
      assert.equal((await get(path)).status, 403, path);
    }
    assert.equal(balance(1), '0');
  });

  test('only GET is allowed, no cookie is set, nothing is cached', async () => {
    assert.equal((await get(PB.credit_150, { method: 'POST' })).status, 405);
    const res = await ok(PB.credit_150, 'Credited');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('a storage failure answers 500 and nothing is half applied', async () => {
    store.db.exec("CREATE TRIGGER fail_balance BEFORE UPDATE OF balance_micro ON users BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    assert.equal((await get(PB.credit_150)).status, 500);
    assert.equal(txCount(), 0);
    store.db.exec('DROP TRIGGER fail_balance');
    await ok(PB.credit_150, 'Credited'); // the retry from Moonetix goes through
    assert.equal(balance(1), '150');
  });
});

test('a missing postback key answers 500, so Moonetix retries', async () => {
  const key = config.postbackKey;
  config.postbackKey = '';
  try {
    assert.equal((await get(PB.credit_150)).status, 500);
  } finally {
    config.postbackKey = key;
  }
  assert.equal(balance(1), '0');
});

describe('earn page', () => {
  test('guests are sent to sign in', async () => {
    const res = await get('/earn');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    assert.equal((await get('/api/offerwall-link')).status, 401);
  });

  test('wrong passwords and forged cookies do not sign in', async () => {
    const { res, cookie } = await signIn('one', 'wrong');
    assert.equal(res.status, 401);
    assert.equal(cookie, null);
    const forged = await get('/earn', { headers: { cookie: `sid=2.9999999999.${'A'.repeat(43)}` } });
    assert.equal(forged.status, 303);
  });

  test('no link before the user confirms 16 or older', async () => {
    const { cookie } = await signIn();
    const page = await (await get('/earn', { headers: { cookie } })).text();
    assert.match(page, /I am 16 or older/);
    assert.doesNotMatch(page, /wall\.moonetix\.com/);
    assert.equal((await get('/api/offerwall-link', { headers: { cookie } })).status, 403);
    const res = await get('/earn/age', { method: 'POST', headers: { cookie }, body: new URLSearchParams({}) });
    assert.equal(res.status, 400);
  });

  test('the signed link is for the signed-in user only', async () => {
    const { cookie } = await signIn();
    const confirm = await get('/earn/age', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ age_16_or_older: '1' }) });
    assert.equal(confirm.status, 303);

    const res = await get('/earn?user_id=2&user=2', { headers: { cookie } });
    const page = await res.text();
    assert.ok(page.includes(`src="${V.links['1'].replace('&', '&amp;')}"`));
    assert.doesNotMatch(page, /user_id=2/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(!page.includes(V.link_salt) && !page.includes(V.postback_key));

    const api = await get('/api/offerwall-link?user_id=2', { headers: { cookie } });
    assert.deepEqual(await api.json(), { url: V.links['1'] });
  });

  test('balance and recent rewards are shown, escaped', async () => {
    await ok(PB.credit_150, 'Credited');
    await ok(PB.credit_decimal, 'Credited');
    const { cookie } = await signIn();
    const page = await (await get('/earn', { headers: { cookie } })).text();
    assert.match(page, /150\.75 coins/);
    assert.match(page, /Bigo Live &amp; &quot;Friends&quot;/);
  });

  test('cross-site form posts are blocked', async () => {
    const { cookie } = await signIn();
    const res = await get('/earn/age', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
      body: new URLSearchParams({ age_16_or_older: '1' }),
    });
    assert.equal(res.status, 403);
  });
});
