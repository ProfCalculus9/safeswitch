import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VaultError,
  newHeader,
  deriveKey,
  encryptVault,
  decryptVault,
  validateBlob,
  toB64,
  fromB64,
  MIN_ITERATIONS,
  DEFAULT_ITERATIONS,
} from '../lib/crypto.js';

const PASS = 'correct horse battery staple';
const payload = { accounts: [{ id: '1', label: 'main', cookies: [{ name: 'reddit_session', value: 'SECRET-VALUE-123' }] }], activeId: '1' };

async function setup() {
  const header = newHeader();
  const key = await deriveKey(PASS, header);
  const blob = await encryptVault(key, header, payload);
  return { header, key, blob };
}

test('round trip returns the original payload', async () => {
  const { key, blob } = await setup();
  assert.deepEqual(await decryptVault(key, blob), payload);
});

test('uses the documented defaults', () => {
  const h = newHeader();
  assert.equal(h.iterations, DEFAULT_ITERATIONS);
  assert.ok(DEFAULT_ITERATIONS >= 600_000);
  assert.equal(fromB64(h.salt).length, 16);
});

test('the stored blob does not contain any plaintext', async () => {
  const { blob } = await setup();
  const text = JSON.stringify(blob);
  assert.ok(!text.includes('SECRET-VALUE-123'));
  assert.ok(!text.includes('reddit_session'));
  assert.ok(!text.includes('main'));
});

test('wrong passphrase fails with DECRYPT_FAILED', async () => {
  const { header, blob } = await setup();
  const wrong = await deriveKey('not the passphrase', header);
  await assert.rejects(() => decryptVault(wrong, blob), (e) => e instanceof VaultError && e.code === 'DECRYPT_FAILED');
});

test('every encryption uses a fresh IV and gives different ciphertext', async () => {
  const { header, key } = await setup();
  const a = await encryptVault(key, header, payload);
  const b = await encryptVault(key, header, payload);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('each new vault gets a unique salt', () => {
  assert.notEqual(newHeader().salt, newHeader().salt);
});

test('flipping a ciphertext byte is detected', async () => {
  const { key, blob } = await setup();
  const bytes = fromB64(blob.ct);
  bytes[5] ^= 0x01;
  await assert.rejects(() => decryptVault(key, { ...blob, ct: toB64(bytes) }), (e) => e.code === 'DECRYPT_FAILED');
});

test('changing the IV is detected', async () => {
  const { key, blob } = await setup();
  const iv = fromB64(blob.iv);
  iv[0] ^= 0x01;
  await assert.rejects(() => decryptVault(key, { ...blob, iv: toB64(iv) }), (e) => e.code === 'DECRYPT_FAILED');
});

test('the header is authenticated: a different salt with the same key fails', async () => {
  const { key, blob } = await setup();
  const otherSalt = newHeader().salt;
  await assert.rejects(() => decryptVault(key, { ...blob, salt: otherSalt }), (e) => e.code === 'DECRYPT_FAILED');
});

test('the header is authenticated: a different iteration count with the same key fails', async () => {
  const { key, blob } = await setup();
  await assert.rejects(() => decryptVault(key, { ...blob, iterations: blob.iterations + 1 }), (e) => e.code === 'DECRYPT_FAILED');
});

test('refuses vaults with a weak or absurd iteration count', async () => {
  const { blob } = await setup();
  assert.throws(() => validateBlob({ ...blob, iterations: MIN_ITERATIONS - 1 }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, iterations: 1 }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, iterations: 2 ** 40 }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, iterations: '600000' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => newHeader(1000), (e) => e.code === 'BAD_VAULT');
});

test('refuses unknown versions, KDFs and malformed fields', async () => {
  const { blob } = await setup();
  assert.throws(() => validateBlob({ ...blob, v: 2 }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, kdf: 'MD5' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, salt: 'AAAA' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, iv: 'AAAA' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, ct: 'AAAA' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob({ ...blob, ct: '!!!not base64!!!' }), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob(null), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => validateBlob('nope'), (e) => e.code === 'BAD_VAULT');
});

test('an empty passphrase is rejected', async () => {
  await assert.rejects(() => deriveKey('', newHeader()), (e) => e.code === 'BAD_PASSPHRASE');
});

test('equivalent Unicode forms of a passphrase derive the same key', async () => {
  const header = newHeader();
  const composed = await deriveKey('café-passphrase', header);
  const decomposed = await deriveKey('café-passphrase', header);
  assert.equal(composed, decomposed);
});

test('base64 helpers round trip large and binary inputs', () => {
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  assert.deepEqual(fromB64(toB64(big)), big);
});
