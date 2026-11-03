import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Encryptor, openDesktopSecrets, setAsideEncryptedSecrets } from './keychainSecrets.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-keychain-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Stands in for the keychain's data key: reversible, tied to the secret's name like the real one,
 * and never stores the plain text.
 */
const fakeKeychain = (keyId = 'fake-key'): Encryptor => ({
  keyId,
  encryptString: (text, name) =>
    Buffer.from(Buffer.from(`enc:${name}:${text}`).map((byte) => byte ^ 0x5a)),
  decryptString: (data, name) => {
    const text = Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8');
    if (!text.startsWith(`enc:${name}:`)) {
      throw new Error('Unsupported state or unable to authenticate data');
    }
    return text.slice(`enc:${name}:`.length);
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

/** Sets a file's modification time to `seconds` ago. */
const age = (path: string, seconds: number): Promise<void> => {
  const time = new Date(Date.now() - seconds * 1000);
  return utimes(path, time, time);
};

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
    expect(JSON.parse(text)).toEqual({
      version: 2,
      keyId: 'fake-key',
      secrets: { cursor: expect.any(String) },
    });
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
    const logger = log();

    const { store, storage } = await open(forgetful, logger);
    await store.set('cursor', 'key_session');

    expect(storage).toBe('importFailed');
    expect(store.get('github')).toBeUndefined();
    expect(await readFile(plainFile(), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['secrets.json']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/secrets\.json is unchanged/));
  });

  test("keeps both files when keys the CLI saved later don't decrypt to the same keys", async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_cursor');
    await writePlain({ github: 'gho_cli' });
    const encrypted = await readFile(encryptedFile(), 'utf8');
    const plain = await readFile(plainFile(), 'utf8');
    const forgetful: Encryptor = {
      ...fakeKeychain(),
      decryptString: (data, name) =>
        fakeKeychain().decryptString(data, name) === 'gho_cli'
          ? 'garbled'
          : fakeKeychain().decryptString(data, name),
    };

    const { storage } = await open(forgetful);

    expect(storage).toBe('importFailed');
    expect(await readFile(encryptedFile(), 'utf8')).toBe(encrypted);
    expect(await readFile(plainFile(), 'utf8')).toBe(plain);
  });

  test('lets a secrets.json newer than the encrypted file, such as the CLI saved, replace its keys', async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_desktop');
    await store.set('linear', 'lin_desktop');
    await age(encryptedFile(), 60);
    await writePlain({ cursor: 'key_cli', anthropic: 'sk-ant-cli' });
    const logger = log();

    const reopened = (await open(fakeKeychain(), logger)).store;

    expect(reopened.get('cursor')).toBe('key_cli');
    expect(reopened.get('anthropic')).toBe('sk-ant-cli');
    expect(reopened.get('linear')).toBe('lin_desktop');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/secrets\.json.*replaced cursor/),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.not.stringContaining('key_'));
    expect((await open(fakeKeychain())).store.get('cursor')).toBe('key_cli');
  });

  test('takes only the missing keys from a secrets.json older than the encrypted file', async () => {
    const { store } = await open(fakeKeychain());
    await store.set('cursor', 'key_desktop');
    await writePlain({ cursor: 'key_stale', anthropic: 'sk-ant-old' });
    await age(plainFile(), 60);
    const logger = log();

    const reopened = (await open(fakeKeychain(), logger)).store;

    expect(reopened.get('cursor')).toBe('key_desktop');
    expect(reopened.get('anthropic')).toBe('sk-ant-old');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/kept the encrypted cursor/));
    expect(logger.info).toHaveBeenCalledWith(expect.not.stringContaining('key_'));
  });

  test('finishes a move that stopped before deleting secrets.json', async () => {
    await writePlain({ github: 'gho_plain' });
    await open(fakeKeychain());
    await writePlain({ github: 'gho_plain' });

    const { store } = await open(fakeKeychain());

    expect(store.get('github')).toBe('gho_plain');
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
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

  test('reads a file from before key ids and writes it with one on the next save', async () => {
    const value = fakeKeychain().encryptString('gho_old', 'github').toString('base64');
    await writeFile(encryptedFile(), JSON.stringify({ version: 1, secrets: { github: value } }));

    const { store, storage } = await open(fakeKeychain());
    await store.set('linear', 'lin_new');

    expect(storage).toBe('keychain');
    expect(store.get('github')).toBe('gho_old');
    expect(JSON.parse(await readFile(encryptedFile(), 'utf8'))).toMatchObject({
      version: 2,
      keyId: 'fake-key',
    });
  });

  test("won't read a value moved to another secret's name", async () => {
    const { store } = await open(fakeKeychain());
    await store.set('github', 'gho_x');
    const file = JSON.parse(await readFile(encryptedFile(), 'utf8'));
    await writeFile(
      encryptedFile(),
      JSON.stringify({ ...file, secrets: { linear: file.secrets.github } }),
    );

    expect((await open(fakeKeychain())).storage).toBe('undecryptable');
  });

  test('keeps a file encrypted with another data key, and new keys only in memory', async () => {
    await (await open(fakeKeychain('old-key'))).store.set('github', 'gho_old');
    const original = await readFile(encryptedFile(), 'utf8');
    const logger = log();

    const { store, storage } = await open(fakeKeychain('new-key'), logger);
    await store.set('cursor', 'key_session');

    expect(storage).toBe('wrongKey');
    expect(store.get('github')).toBeUndefined();
    expect(store.get('cursor')).toBe('key_session');
    expect(await readFile(encryptedFile(), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/data key/));
    expect((await open(fakeKeychain('old-key'))).store.get('github')).toBe('gho_old');
  });

  test('starts over by moving the encrypted file aside, so its keys can still be restored', async () => {
    await (await open(fakeKeychain('old-key'))).store.set('github', 'gho_old');
    const original = await readFile(encryptedFile(), 'utf8');

    const asideName = await setAsideEncryptedSecrets(dir);
    const { store, storage } = await open(fakeKeychain('new-key'));
    await store.set('cursor', 'key_new');

    expect(storage).toBe('keychain');
    expect(asideName).toMatch(/^secrets\.encrypted\.old-key\.\d+\.json$/);
    expect(await readFile(join(dir, asideName ?? ''), 'utf8')).toBe(original);
    expect(await modeOf(join(dir, asideName ?? ''))).toBe(0o600);
    expect((await open(fakeKeychain('new-key'))).store.get('cursor')).toBe('key_new');
  });

  test.each([
    ['not JSON', '{ not json'],
    ['not a secrets file', JSON.stringify({ version: 1, secrets: { cursor: 5 } })],
  ])('reports a file that is %s as damaged and leaves it in place', async (_name, text) => {
    await writeFile(encryptedFile(), text);
    const logger = log();

    const { store, storage } = await open(fakeKeychain(), logger);

    expect(storage).toBe('corrupt');
    expect(store.get('cursor')).toBeUndefined();
    expect(await readFile(encryptedFile(), 'utf8')).toBe(text);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('damaged'));

    await store.set('linear', 'lin_new');
    expect((await open(fakeKeychain())).store.get('linear')).toBe('lin_new');
  });

  test('refuses a file from a newer PR Quest instead of dropping its keys', async () => {
    const text = JSON.stringify({ version: 3, keyId: 'fake-key', secrets: {} });
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

  test('removes a deleted key from secrets.json too, so signing out lasts', async () => {
    await writePlain({ github: 'gho_plain', cursor: 'key_plain' });

    const { store } = await open(undefined);
    await store.delete('github');
    await store.delete('linear');

    expect(store.get('github')).toBeUndefined();
    const reopened = (await open(undefined)).store;
    expect(reopened.get('github')).toBeUndefined();
    expect(reopened.get('cursor')).toBe('key_plain');
    expect(await readdir(dir)).toEqual(['secrets.json']);
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
