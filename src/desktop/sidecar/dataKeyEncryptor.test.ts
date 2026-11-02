import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ENCRYPTED_SECRETS_FILE, openDesktopSecrets } from '../keychainSecrets.ts';
import { DATA_KEY_BYTES, dataKeyEncryptor } from './dataKeyEncryptor.ts';

const quiet = { info: () => undefined, warn: () => undefined };

describe('dataKeyEncryptor', () => {
  test('decrypts what it encrypted, with a fresh nonce each time', () => {
    const encryptor = dataKeyEncryptor(randomBytes(DATA_KEY_BYTES));

    const first = encryptor.encryptString('crsr_secret');
    const second = encryptor.encryptString('crsr_secret');

    expect(encryptor.decryptString(first)).toBe('crsr_secret');
    expect(first.equals(second)).toBe(false);
    expect(first.toString('latin1')).not.toContain('crsr_secret');
  });

  test('refuses a different key, a tampered value and an unknown format', () => {
    const encryptor = dataKeyEncryptor(randomBytes(DATA_KEY_BYTES));
    const encrypted = encryptor.encryptString('crsr_secret');
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    const unknownFormat = Buffer.from(encrypted);
    unknownFormat[0] = 9;

    expect(() => dataKeyEncryptor(randomBytes(DATA_KEY_BYTES)).decryptString(encrypted)).toThrow();
    expect(() => encryptor.decryptString(tampered)).toThrow();
    expect(() => encryptor.decryptString(unknownFormat)).toThrow(/format/);
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

    expect(other.storage).toBe('undecryptable');
    expect(other.store.get('cursor')).toBeUndefined();
  });
});
