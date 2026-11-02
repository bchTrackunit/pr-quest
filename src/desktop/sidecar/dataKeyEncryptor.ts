import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Encryptor } from '../keychainSecrets.ts';

/** The per-install AES-256 key the Tauri shell keeps in the OS keychain and hands over on stdin. */
export const DATA_KEY_BYTES = 32;
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Ties each value to this use of the key, so ciphertext made with it elsewhere doesn't decrypt. */
const ASSOCIATED_DATA = Buffer.from('pr-quest secrets.encrypted.json v1');

/**
 * Encrypts saved keys with AES-256-GCM under `key`, as the `Encryptor` that
 * `openDesktopSecrets` takes in place of Electron's `safeStorage`. Each value is
 * `version (1 byte) | nonce (12) | tag (16) | ciphertext`.
 */
export function dataKeyEncryptor(key: Buffer): Encryptor {
  if (key.length !== DATA_KEY_BYTES) {
    throw new Error(`The data key must be ${DATA_KEY_BYTES} bytes`);
  }
  return {
    encryptString: (plainText) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(ASSOCIATED_DATA);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.of(FORMAT_VERSION), nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (encrypted) => {
      if (encrypted[0] !== FORMAT_VERSION || encrypted.length < 1 + NONCE_BYTES + TAG_BYTES) {
        throw new Error('Not a value in the data key format');
      }
      const nonce = encrypted.subarray(1, 1 + NONCE_BYTES);
      const tag = encrypted.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
        .setAAD(ASSOCIATED_DATA)
        .setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted.subarray(1 + NONCE_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
