import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatMicro, readParams, toMicro, validHash, wallUrl } from '../src/moonetix.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/moonetix-vectors.json', import.meta.url)));
const config = { appId: V.app_id, linkSalt: V.link_salt };

test('signed links match the links made by Moonetix', () => {
  for (const [userId, link] of Object.entries(V.links)) {
    assert.equal(wallUrl(config, userId), link, userId);
  }
  assert.equal(wallUrl(config, 42), V.links['42']);
});

test('sub IDs are appended, invalid ones dropped', () => {
  const url = wallUrl(config, '42', { sub1: 'earn_page', sub2: 'bad value!', sub9: 'x', sub3: 'a~b' });
  assert.equal(url, `${V.links['42']}&sub1=earn_page&sub3=a~b`);
});

test('user IDs the offerwall rejects throw', () => {
  for (const bad of ['', 'has space', 'x'.repeat(101), 'café']) {
    assert.throws(() => wallUrl(config, bad), /user ID/);
  }
});

test('a missing salt throws instead of signing with an empty key', () => {
  assert.throws(() => wallUrl({ appId: V.app_id, linkSalt: '' }, '1'), /MOONETIX_LINK_SALT is not set/);
  const p = { tx: 'a', user: '1', reward: '1', status: '1', hash: 'x' };
  assert.throws(() => validHash(undefined, p), /MOONETIX_POSTBACK_KEY is not set/);
});

test('readParams accepts exactly one string per key', () => {
  const q = { tx: 't', user: '1', reward: '1', status: '1', hash: 'h', offer: 'o' };
  assert.deepEqual(readParams((k) => q[k]), { ...q });
  assert.equal(readParams((k) => ({ ...q, tx: ['t', 't'] })[k]), null);
  assert.equal(readParams((k) => ({ ...q, hash: undefined })[k]), null);
});

test('hashes of another length or with multibyte characters are a clean mismatch', () => {
  const p = { tx: 'a', user: '1', reward: '1', status: '1' };
  assert.equal(validHash(V.postback_key, { ...p, hash: 'abc' }), false);
  assert.equal(validHash(V.postback_key, { ...p, hash: 'é'.repeat(64) }), false);
});

test('amounts are exact', () => {
  assert.equal(toMicro('150'), 150_000_000);
  assert.equal(toMicro('0.75'), 750_000);
  assert.equal(toMicro('1.23456'), 1_234_560);
  assert.equal(toMicro('1234567.125'), 1_234_567_125_000);
  for (const bad of ['-1', '1e3', '1.', '', ' 1', '1.1234567', '0x10']) assert.equal(toMicro(bad), null, bad);
  assert.equal(formatMicro(151_984_560), '151.98456');
  assert.equal(formatMicro(-250_000), '-0.25');
  assert.equal(formatMicro(0), '0');
});
