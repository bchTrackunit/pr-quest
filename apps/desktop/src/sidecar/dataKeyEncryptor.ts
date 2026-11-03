import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { SecretName } from '@pr-quest/server/secrets';
import type { Encryptor } from '../keychainSecrets.ts';

/** The per-install AES-256 key the Tauri shell keeps in the OS keychain and hands over on stdin. */
export const DATA_KEY_BYTES = 32;
/** Values from before they were bound to their secret's name, which are still read. */
const V1 = 1;
const V2 = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

/**
 * Ties each value to this use of the key and, from v2, to its secret, so ciphertext made with the
 * key elsewhere, or moved to another secret's name, doesn't decrypt.
 */
function associatedData(version: number, name: SecretName): Buffer {
  return Buffer.from(
    version === V1
      ? 'pr-quest secrets.encrypted.json v1'
      : `pr-quest secrets.encrypted.json v2 ${name}`,
  );
}

/**
 * Encrypts saved keys with AES-256-GCM under `key`, as the `Encryptor` that
 * `openDesktopSecrets` takes. Each value is `version (1 byte) | nonce (12) | tag (16) | ciphertext`.
 */
export function dataKeyEncryptor(key: Buffer): Encryptor {
  if (key.length !== DATA_KEY_BYTES) {
    throw new Error(`The data key must be ${DATA_KEY_BYTES} bytes`);
  }
  return {
    keyId: createHash('sha256')
      .update('pr-quest data key id\0')
      .update(key)
      .digest('hex')
      .slice(0, 16),
    encryptString: (plainText, name) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(associatedData(V2, name));
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.of(V2), nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (encrypted, name, acceptV1) => {
      const version = encrypted[0] ?? 0;
      if ((version !== V1 && version !== V2) || encrypted.length < HEADER_BYTES) {
        throw new Error('Not a value in the data key format');
      }
      if (version === V1 && !acceptV1) {
        throw new Error(
          "A version 1 value, which isn't bound to its secret, where only version 2 belongs",
        );
      }
      const nonce = encrypted.subarray(1, 1 + NONCE_BYTES);
      const tag = encrypted.subarray(1 + NONCE_BYTES, HEADER_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
        .setAAD(associatedData(version, name))
        .setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted.subarray(HEADER_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
