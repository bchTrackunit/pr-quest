import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest. A master key from the environment wraps one data key
 * per user, and each data key seals that user's secrets. Both layers use AES-256-GCM with a random
 * 96-bit nonce and bind a context string as associated data, so a sealed value copied to another
 * user or secret no longer opens. Rotating the master key only rewraps data keys.
 *
 * Sealed layout: format byte (1), nonce (12), auth tag (16), ciphertext.
 */

const FORMAT = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export const MASTER_KEY_VARIABLE = 'PR_QUEST_MASTER_KEY';
export const PREVIOUS_MASTER_KEYS_VARIABLE = 'PR_QUEST_PREVIOUS_MASTER_KEYS';

/** A data key as stored: which master key wrapped it, and the sealed bytes. */
export interface WrappedKey {
  masterKeyId: string;
  wrapped: Buffer;
}

export interface MasterKeyConfig {
  /** Base64 of 32 random bytes; it wraps every new data key. */
  current: string;
  /** Comma-separated older keys that still unwrap, while their data keys are rewrapped. */
  previous?: string;
}

/** A fresh random data key. */
export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** The master keys this server holds. It never logs or returns key material. */
export class MasterKeyring {
  public readonly currentId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  private constructor(currentId: string, keys: ReadonlyMap<string, Buffer>) {
    this.currentId = currentId;
    this.keys = keys;
  }

  public static fromConfig(config: MasterKeyConfig): MasterKeyring {
    const current = parseKey(config.current, MASTER_KEY_VARIABLE);
    const keys = new Map<string, Buffer>([[keyId(current), current]]);
    for (const entry of (config.previous ?? '').split(',')) {
      if (entry.trim() !== '') {
        const key = parseKey(entry.trim(), PREVIOUS_MASTER_KEYS_VARIABLE);
        keys.set(keyId(key), key);
      }
    }
    return new MasterKeyring(keyId(current), keys);
  }

  /** Whether `masterKeyId` is the current key, so data keys wrapped by others can be rewrapped. */
  public isCurrent(masterKeyId: string): boolean {
    return masterKeyId === this.currentId;
  }

  /** Wraps `dataKey` with the current master key, bound to `context`. */
  public wrap(dataKey: Buffer, context: string): WrappedKey {
    return {
      masterKeyId: this.currentId,
      wrapped: sealBytes(this.masterKey(this.currentId), dataKey, wrapContext(context)),
    };
  }

  public unwrap(key: WrappedKey, context: string): Buffer {
    const dataKey = openBytes(this.masterKey(key.masterKeyId), key.wrapped, wrapContext(context));
    if (dataKey?.length !== KEY_BYTES) {
      throw new Error(
        `A data key could not be unwrapped with master key ${key.masterKeyId}: the key is wrong or the stored data was changed`,
      );
    }
    return dataKey;
  }

  private masterKey(id: string): Buffer {
    const key = this.keys.get(id);
    if (!key) {
      throw new Error(
        `A data key was wrapped with master key ${id}, which isn't configured. Add that key to ${PREVIOUS_MASTER_KEYS_VARIABLE}.`,
      );
    }
    return key;
  }
}

/** Encrypts `plaintext` under `key`, bound to `context`. */
export function seal(key: Buffer, plaintext: string, context: string): Buffer {
  return sealBytes(key, Buffer.from(plaintext, 'utf8'), secretContext(context));
}

/** The plaintext `seal` produced. Throws when the key, the context or a byte is wrong. */
export function openSealed(key: Buffer, sealed: Buffer, context: string): string {
  const plaintext = openBytes(key, sealed, secretContext(context));
  if (!plaintext) {
    throw new Error(
      'A secret could not be decrypted: the key or context is wrong or the stored data was changed',
    );
  }
  return plaintext.toString('utf8');
}

const wrapContext = (context: string): string => `pr-quest:data-key:${FORMAT}:${context}`;
const secretContext = (context: string): string => `pr-quest:secret:${FORMAT}:${context}`;

function sealBytes(key: Buffer, plaintext: Buffer, context: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(FORMAT), nonce, cipher.getAuthTag(), ciphertext]);
}

function openBytes(key: Buffer, sealed: Buffer, context: string): Buffer | undefined {
  if (sealed.length < HEADER_BYTES || sealed[0] !== FORMAT) {
    return undefined;
  }
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(1 + NONCE_BYTES, HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  }
}

/** A short public name for a master key, so rows can say which key wrapped them. */
function keyId(key: Buffer): string {
  const digest = createHash('sha256').update('pr-quest:master-key-id\0').update(key).digest('hex');
  return `mk_${digest.slice(0, 16)}`;
}

function parseKey(text: string, variable: string): Buffer {
  const key = BASE64_PATTERN.test(text) ? Buffer.from(text, 'base64') : undefined;
  if (key?.length !== KEY_BYTES) {
    throw new Error(
      `${variable} must be 32 random bytes, base64-encoded; create one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}
