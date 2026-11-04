import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ENCRYPTED_SECRETS_FILE, openDesktopSecrets } from '../keychainSecrets.ts';
import { DATA_KEY_BYTES, dataKeyEncryptor } from './dataKeyEncryptor.ts';

const quiet = { info: () => undefined, warn: () => undefined };

/** A value as version 1 wrote it, before values were bound to their secret's name. */
function v1Value(key: Buffer, plainText: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(
    Buffer.from('pr-quest secrets.encrypted.json v1'),
  );
  const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.of(1), nonce, cipher.getAuthTag(), body]);
}

describe('dataKeyEncryptor', () => {
  test('decrypts what it encrypted, with a fresh nonce each time', () => {
    const encryptor = dataKeyEncryptor(randomBytes(DATA_KEY_BYTES));

    const first = encryptor.encryptString('crsr_secret', 'cursor');
    const second = encryptor.encryptString('crsr_secret', 'cursor');

    expect(encryptor.decryptString(first, 'cursor')).toBe('crsr_secret');
    expect(first.equals(second)).toBe(false);
    expect(first.toString('latin1')).not.toContain('crsr_secret');
  });

  test("binds each value to its secret's name", () => {
    const encryptor = dataKeyEncryptor(randomBytes(DATA_KEY_BYTES));

    const encrypted = encryptor.encryptString('crsr_secret', 'cursor');

    expect(() => encryptor.decryptString(encrypted, 'linear')).toThrow();
  });

  test('refuses a value from before values were bound to a name, which PR Quest never shipped', () => {
    const key = randomBytes(DATA_KEY_BYTES);

    expect(() => dataKeyEncryptor(key).decryptString(v1Value(key, 'crsr_old'), 'cursor')).toThrow(
      /format/,
    );
  });

  test('names its key with an id that tells keys apart without giving one away', () => {
    const key = randomBytes(DATA_KEY_BYTES);
    const { keyId } = dataKeyEncryptor(key);

    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(dataKeyEncryptor(Buffer.from(key)).keyId).toBe(keyId);
    expect(dataKeyEncryptor(randomBytes(DATA_KEY_BYTES)).keyId).not.toBe(keyId);
    expect(key.toString('hex')).not.toContain(keyId);
  });

  test('refuses a different key, a tampered value and an unknown format', () => {
    const encryptor = dataKeyEncryptor(randomBytes(DATA_KEY_BYTES));
    const encrypted = encryptor.encryptString('crsr_secret', 'cursor');
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    const unknownFormat = Buffer.from(encrypted);
    unknownFormat[0] = 9;

    expect(() =>
      dataKeyEncryptor(randomBytes(DATA_KEY_BYTES)).decryptString(encrypted, 'cursor'),
    ).toThrow();
    expect(() => encryptor.decryptString(tampered, 'cursor')).toThrow();
    expect(() => encryptor.decryptString(unknownFormat, 'cursor')).toThrow(/format/);
  });

  test('needs a 256-bit key', () => {
    expect(() => dataKeyEncryptor(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('the desktop secrets with a data key', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'pr-quest-data-key-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test('import secrets.json, encrypt it with the key and read it back on the next start', async () => {
    const key = randomBytes(DATA_KEY_BYTES);
    await writeFile(
      join(stateDir, 'secrets.json'),
      JSON.stringify({ version: 1, secrets: { cursor: 'crsr_1' } }),
    );

    const first = await openDesktopSecrets(stateDir, {
      encryptor: dataKeyEncryptor(key),
      allowPlaintext: false,
      ...quiet,
    });
    const file = await readFile(join(stateDir, ENCRYPTED_SECRETS_FILE), 'utf8');
    const again = await openDesktopSecrets(stateDir, {
      encryptor: dataKeyEncryptor(key),
      allowPlaintext: false,
      ...quiet,
    });

    expect(first.storage).toBe('keychain');
    expect(file).not.toContain('crsr_1');
    expect(again.store.get('cursor')).toBe('crsr_1');
  });

  test('start without the keys when the keychain hands over a different data key', async () => {
    const saved = await openDesktopSecrets(stateDir, {
      encryptor: dataKeyEncryptor(randomBytes(DATA_KEY_BYTES)),
      allowPlaintext: false,
      ...quiet,
    });
    await saved.store.set('cursor', 'crsr_1');

    const other = await openDesktopSecrets(stateDir, {
      encryptor: dataKeyEncryptor(randomBytes(DATA_KEY_BYTES)),
      allowPlaintext: false,
      ...quiet,
    });

    expect(other.storage).toBe('wrongKey');
    expect(other.store.get('cursor')).toBeUndefined();
  });

  const openWith = (key: Buffer) =>
    openDesktopSecrets(stateDir, {
      encryptor: dataKeyEncryptor(key),
      allowPlaintext: false,
      ...quiet,
    });
  const writeEncrypted = (file: object) =>
    writeFile(join(stateDir, ENCRYPTED_SECRETS_FILE), JSON.stringify(file));

  test('take a version 1 file for a damaged one, and keep it aside once a key is saved', async () => {
    const key = randomBytes(DATA_KEY_BYTES);
    await writeEncrypted({
      version: 1,
      secrets: { cursor: v1Value(key, 'crsr_old').toString('base64') },
    });
    const original = await readFile(join(stateDir, ENCRYPTED_SECRETS_FILE), 'utf8');

    const opened = await openWith(key);
    await opened.store.set('linear', 'lin_new');

    expect(opened.storage).toBe('corrupt');
    expect(opened.store.get('cursor')).toBeUndefined();
    const aside = (await readdir(stateDir)).find((name) =>
      /^secrets\.encrypted\.unknown-key\.\d+\.json$/.test(name),
    );
    expect(await readFile(join(stateDir, aside ?? ''), 'utf8')).toBe(original);
    expect((await openWith(key)).store.get('linear')).toBe('lin_new');
  });

  test("refuse a version 1 value in a version 2 file, which isn't bound to its name", async () => {
    const key = randomBytes(DATA_KEY_BYTES);
    await writeEncrypted({
      version: 2,
      keyId: dataKeyEncryptor(key).keyId,
      secrets: { cursor: v1Value(key, 'crsr_moved').toString('base64') },
    });

    const opened = await openWith(key);

    expect(opened.storage).toBe('undecryptable');
    expect(opened.store.get('cursor')).toBeUndefined();
  });
});
