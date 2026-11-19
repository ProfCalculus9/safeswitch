// SafeSwitch vault crypto. WebCrypto only: no dependencies, no network.
//
// Vault blob (kept in chrome.storage.local), all binary fields base64:
//   { v, kdf, iterations, salt, iv, ct }
//
// - key = PBKDF2-SHA256(passphrase, salt, iterations) -> 256 bits
// - ct  = AES-256-GCM(key, iv, JSON(payload))
// - The header fields (v, kdf, iterations, salt) are bound in as additional
//   authenticated data, so changing any of them makes decryption fail.
// - A fresh random 96-bit IV is used for every encryption.

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export const VAULT_VERSION = 1;
export const KDF_NAME = 'PBKDF2-SHA256';
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 200_000; // refuse imported vaults weaker than this
export const MAX_ITERATIONS = 5_000_000; // refuse absurd values that would hang the worker
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromB64(str) {
  if (typeof str !== 'string') throw new VaultError('BAD_VAULT', 'Malformed vault data.');
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new VaultError('BAD_VAULT', 'Malformed vault data.');
  }
}

function checkIterations(n) {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new VaultError('BAD_VAULT', 'Unsupported key-derivation settings.');
  }
}

export function newHeader(iterations = DEFAULT_ITERATIONS) {
  checkIterations(iterations);
  return {
    v: VAULT_VERSION,
    kdf: KDF_NAME,
    iterations,
    salt: toB64(crypto.getRandomValues(new Uint8Array(SALT_BYTES))),
  };
}

export function validateHeader(h) {
  if (!h || typeof h !== 'object') throw new VaultError('BAD_VAULT', 'Malformed vault.');
  if (h.v !== VAULT_VERSION) throw new VaultError('BAD_VAULT', 'Unsupported vault version.');
  if (h.kdf !== KDF_NAME) throw new VaultError('BAD_VAULT', 'Unsupported key-derivation function.');
  checkIterations(h.iterations);
  if (fromB64(h.salt).length !== SALT_BYTES) throw new VaultError('BAD_VAULT', 'Malformed vault salt.');
  return h;
}

export function validateBlob(blob) {
  validateHeader(blob);
  if (fromB64(blob.iv).length !== IV_BYTES) throw new VaultError('BAD_VAULT', 'Malformed vault IV.');
  if (fromB64(blob.ct).length < GCM_TAG_BYTES) throw new VaultError('BAD_VAULT', 'Malformed vault data.');
  return blob;
}

// Returns the raw 256-bit key as base64. The caller keeps it only in
// chrome.storage.session (memory), never on disk.
export async function deriveKey(passphrase, header) {
  validateHeader(header);
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new VaultError('BAD_PASSPHRASE', 'A passphrase is required.');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(header.salt), iterations: header.iterations },
    material,
    256,
  );
  return toB64(new Uint8Array(bits));
}

function aad(h) {
  return encoder.encode(`safeswitch|${h.v}|${h.kdf}|${h.iterations}|${h.salt}`);
}

async function importAesKey(rawB64) {
  return crypto.subtle.importKey('raw', fromB64(rawB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptVault(rawKeyB64, header, payload) {
  validateHeader(header);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(header) },
    await importAesKey(rawKeyB64),
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    v: header.v,
    kdf: header.kdf,
    iterations: header.iterations,
    salt: header.salt,
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
  };
}

export async function decryptVault(rawKeyB64, blob) {
  validateBlob(blob);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: aad(blob) },
      await importAesKey(rawKeyB64),
      fromB64(blob.ct),
    );
  } catch {
    throw new VaultError('DECRYPT_FAILED', 'Wrong passphrase, or the vault is damaged.');
  }
  try {
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new VaultError('BAD_VAULT', 'The vault contents are malformed.');
  }
}
