import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Encryptor, keychainUsable, openDesktopSecrets } from './keychainSecrets.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-keychain-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Stands in for Electron's safeStorage: reversible, and never stores the plain text. */
const fakeKeychain = (): Encryptor => ({
  encryptString: (text) => Buffer.from(Buffer.from(`enc:${text}`).map((byte) => byte ^ 0x5a)),
  decryptString: (data) => {
    const text = Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage');
    }
    return text.slice('enc:'.length);
  },
});

const log = () => ({ info: vi.fn(), warn: vi.fn() });

const open = (encryptor: Encryptor | undefined, logger = log(), allowPlaintext = false) =>
  openDesktopSecrets(dir, { encryptor, allowPlaintext, ...logger });

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const plainFile = (): string => join(dir, 'secrets.json');
const encryptedFile = (): string => join(dir, 'secrets.encrypted.json');

const writePlain = (secrets: Record<string, string>): Promise<void> =>
  writeFile(plainFile(), JSON.stringify({ version: 1, secrets }));

/** An encrypted file this keychain can't decrypt, as one from another computer would be. */
const writeForeignEncrypted = (): Promise<void> =>
  writeFile(
    encryptedFile(),
    JSON.stringify({ version: 1, secrets: { cursor: Buffer.from('sk-leak').toString('base64') } }),
  );

describe('openDesktopSecrets with the OS keychain', () => {
  test('starts empty and writes nothing until a secret is saved', async () => {
    const { store, storage } = await open(fakeKeychain());

    expect(storage).toBe('keychain');
    expect(store.get('cursor')).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  test('saves secrets encrypted, never in plain text, with mode 0600', async () => {
    const { store } = await open(fakeKeychain());

    await store.set('cursor', 'key_cursor_secret');

    const text = await readFile(encryptedFile(), 'utf8');
    expect(text).not.toContain('key_cursor_secret');
    expect(JSON.parse(text)).toEqual({ version: 1, secrets: { cursor: expect.any(String) } });
    expect(await modeOf(encryptedFile())).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect((await open(fakeKeychain())).store.get('cursor')).toBe('key_cursor_secret');
  });

  test('deletes a secret', async () => {
    const { store } = await open(fakeKeychain());
    await store.set('github', 'gho_x');
    await store.set('linear', 'lin_x');

    await store.delete('github');

    expect(store.get('github')).toBeUndefined();
    const reopened = (await open(fakeKeychain())).store;
    expect(reopened.get('github')).toBeUndefined();
    expect(reopened.get('linear')).toBe('lin_x');
  });

  test('writes atomically, leaving no temp files', async () => {
    const { store } = await open(fakeKeychain());

    await Promise.all([store.set('cursor', 'a'), store.set('linear', 'b')]);

    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect((await open(fakeKeychain())).store.get('cursor')).toBe('a');
  });

  test('moves secrets.json into the keychain, checks the encrypted copy, then deletes it', async () => {
    await writePlain({ github: 'gho_plain', anthropic: 'sk-ant-plain' });
    const logger = log();

    const { store, storage } = await open(fakeKeychain(), logger);

    expect(storage).toBe('keychain');
    expect(store.get('github')).toBe('gho_plain');
    expect(store.get('anthropic')).toBe('sk-ant-plain');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(await readFile(encryptedFile(), 'utf8')).not.toContain('gho_plain');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted'));
    expect(logger.info).toHaveBeenCalledWith(expect.not.stringContaining('gho_plain'));
  });

  test("keeps secrets.json when the encrypted copy doesn't decrypt to the same keys", async () => {
    await writePlain({ github: 'gho_plain' });
    const original = await readFile(plainFile(), 'utf8');
    const forgetful: Encryptor = { ...fakeKeychain(), decryptString: () => 'something else' };

    await expect(open(forgetful)).rejects.toThrow(/secrets\.json is unchanged/);

    expect(await readFile(plainFile(), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['secrets.json']);
  });

  test("keeps both files when keys the CLI saved later don't decrypt to the same keys", async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_cursor');
    await writePlain({ github: 'gho_cli' });
    const encrypted = await readFile(encryptedFile(), 'utf8');
    const plain = await readFile(plainFile(), 'utf8');
    const forgetful: Encryptor = {
      ...fakeKeychain(),
      decryptString: (data) =>
        fakeKeychain().decryptString(data) === 'gho_cli'
          ? 'garbled'
          : fakeKeychain().decryptString(data),
    };

    await expect(open(forgetful)).rejects.toThrow(/secrets\.json is unchanged/);

    expect(await readFile(encryptedFile(), 'utf8')).toBe(encrypted);
    expect(await readFile(plainFile(), 'utf8')).toBe(plain);
  });

  test('imports a secrets.json written later, such as by the CLI, then deletes it', async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_desktop');
    await store.set('linear', 'lin_desktop');
    await writePlain({ cursor: 'key_cli' });
    const logger = log();

    const reopened = (await open(fakeKeychain(), logger)).store;

    expect(reopened.get('cursor')).toBe('key_cli');
    expect(reopened.get('linear')).toBe('lin_desktop');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('secrets.json'));
    expect((await open(fakeKeychain())).store.get('cursor')).toBe('key_cli');
  });

  test('finishes a move that stopped before deleting secrets.json', async () => {
    await writePlain({ github: 'gho_plain' });
    await open(fakeKeychain());
    await writePlain({ github: 'gho_plain' });

    const { store } = await open(fakeKeychain());

    expect(store.get('github')).toBe('gho_plain');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
  });

  test('deletes the secrets.json.bak an earlier build kept, once the encrypted file decrypts', async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_cursor');
    await writeFile(join(dir, 'secrets.json.bak'), JSON.stringify({ version: 1, secrets: {} }));
    const logger = log();

    await open(fakeKeychain(), logger);

    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('secrets.json.bak'));
  });

  test("leaves a file the keychain can't decrypt in place and saves nothing until a key is set", async () => {
    await writeForeignEncrypted();
    const original = await readFile(encryptedFile(), 'utf8');
    const logger = log();

    const { store, storage } = await open(fakeKeychain(), logger);
    await store.delete('cursor');

    expect(storage).toBe('undecryptable');
    expect(store.get('cursor')).toBeUndefined();
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(await readFile(encryptedFile(), 'utf8')).toBe(original);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keychain'));
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining('sk-leak'));

    await store.set('linear', 'lin_new');
    expect((await open(fakeKeychain())).store.get('linear')).toBe('lin_new');
  });

  test('leaves an unreadable file in place too', async () => {
    await writeFile(encryptedFile(), '{ not json');

    const { store, storage } = await open(fakeKeychain());

    expect(storage).toBe('undecryptable');
    expect(store.get('cursor')).toBeUndefined();
    expect(await readFile(encryptedFile(), 'utf8')).toBe('{ not json');
  });

  test('refuses a file from a newer PR Quest instead of dropping its keys', async () => {
    const text = JSON.stringify({ version: 2, secrets: {} });
    await writeFile(encryptedFile(), text);

    await expect(open(fakeKeychain())).rejects.toThrow(/newer version of PR Quest/);

    expect(await readFile(encryptedFile(), 'utf8')).toBe(text);
  });
});

describe('openDesktopSecrets without the OS keychain', () => {
  test('keeps saved keys in memory only, reading an existing secrets.json without changing it', async () => {
    await writePlain({ cursor: 'key_plain' });
    const original = await readFile(plainFile(), 'utf8');
    const logger = log();

    const { store, storage } = await open(undefined, logger);
    await store.set('linear', 'lin_memory');

    expect(storage).toBe('memory');
    expect(store.get('cursor')).toBe('key_plain');
    expect(store.get('linear')).toBe('lin_memory');
    expect(await readdir(dir)).toEqual(['secrets.json']);
    expect(await readFile(plainFile(), 'utf8')).toBe(original);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('until PR Quest quits'));
    expect((await open(undefined)).store.get('linear')).toBeUndefined();
  });

  test('saves them unencrypted in secrets.json once the player agreed to it', async () => {
    const logger = log();

    const { store, storage } = await open(undefined, logger, true);
    await store.set('linear', 'lin_plain');

    expect(storage).toBe('plaintext');
    expect(await readdir(dir)).toEqual(['secrets.json']);
    expect(await readFile(plainFile(), 'utf8')).toContain('lin_plain');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
  });

  test('never writes secrets.json while encrypted keys wait for the keychain', async () => {
    await writeForeignEncrypted();
    const original = await readFile(encryptedFile(), 'utf8');

    const { store, storage } = await open(undefined, log(), true);
    await store.set('cursor', 'key_session');

    expect(storage).toBe('locked');
    expect(store.get('cursor')).toBe('key_session');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(await readFile(encryptedFile(), 'utf8')).toBe(original);
  });
});

describe('keychainUsable', () => {
  test('uses the keychain wherever safeStorage can encrypt', () => {
    expect(keychainUsable({ platform: 'darwin', isAvailable: true })).toBe(true);
    expect(keychainUsable({ platform: 'win32', isAvailable: true })).toBe(true);
    expect(
      keychainUsable({ platform: 'linux', isAvailable: true, backend: 'gnome_libsecret' }),
    ).toBe(true);
  });

  test('not when safeStorage cannot encrypt', () => {
    expect(keychainUsable({ platform: 'darwin', isAvailable: false })).toBe(false);
  });

  test.each(['basic_text', 'unknown'])(
    'not on Linux with the %s backend, whose fixed password protects nothing',
    (backend) => {
      expect(keychainUsable({ platform: 'linux', isAvailable: true, backend })).toBe(false);
    },
  );
});
