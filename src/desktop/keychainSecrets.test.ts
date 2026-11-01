import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Encryptor, openDesktopSecrets } from './keychainSecrets.ts';

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

const open = (encryptor: Encryptor | undefined, logger = log()) =>
  openDesktopSecrets(dir, { encryptor, ...logger });

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const writePlain = (secrets: Record<string, string>): Promise<void> =>
  writeFile(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets }));

describe('openDesktopSecrets with the OS keychain', () => {
  test('starts empty and writes nothing until a secret is saved', async () => {
    const secrets = await open(fakeKeychain());

    expect(secrets.get('cursor')).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  test('saves secrets encrypted, never in plain text, with mode 0600', async () => {
    const secrets = await open(fakeKeychain());

    await secrets.set('cursor', 'key_cursor_secret');

    const file = join(dir, 'secrets.encrypted.json');
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('key_cursor_secret');
    expect(JSON.parse(text)).toEqual({ version: 1, secrets: { cursor: expect.any(String) } });
    expect(await modeOf(file)).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect((await open(fakeKeychain())).get('cursor')).toBe('key_cursor_secret');
  });

  test('deletes a secret', async () => {
    const secrets = await open(fakeKeychain());
    await secrets.set('github', 'gho_x');
    await secrets.set('linear', 'lin_x');

    await secrets.delete('github');

    expect(secrets.get('github')).toBeUndefined();
    const reopened = await open(fakeKeychain());
    expect(reopened.get('github')).toBeUndefined();
    expect(reopened.get('linear')).toBe('lin_x');
  });

  test('writes atomically, leaving no temp files', async () => {
    const secrets = await open(fakeKeychain());

    await Promise.all([secrets.set('cursor', 'a'), secrets.set('linear', 'b')]);

    expect(await readdir(dir)).toEqual(['secrets.encrypted.json']);
    expect((await open(fakeKeychain())).get('cursor')).toBe('a');
  });

  test('moves the plain-text secrets.json into the keychain once, keeping a .bak copy', async () => {
    await writePlain({ github: 'gho_plain', anthropic: 'sk-ant-plain' });
    const original = await readFile(join(dir, 'secrets.json'), 'utf8');
    const logger = log();

    const secrets = await open(fakeKeychain(), logger);

    expect(secrets.get('github')).toBe('gho_plain');
    expect(secrets.get('anthropic')).toBe('sk-ant-plain');
    expect((await readdir(dir)).toSorted()).toEqual(['secrets.encrypted.json', 'secrets.json.bak']);
    expect(await readFile(join(dir, 'secrets.json.bak'), 'utf8')).toBe(original);
    expect(await readFile(join(dir, 'secrets.encrypted.json'), 'utf8')).not.toContain('gho_plain');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('secrets.json.bak'));
    expect(logger.info).toHaveBeenCalledWith(expect.not.stringContaining('gho_plain'));
  });

  test('ignores a secrets.json that appears after the move, such as one the CLI wrote', async () => {
    const secrets = await open(fakeKeychain());
    await secrets.set('cursor', 'key_desktop');
    await writePlain({ cursor: 'key_cli' });

    const reopened = await open(fakeKeychain());

    expect(reopened.get('cursor')).toBe('key_desktop');
    expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toContain('key_cli');
  });

  test('moves a file the keychain cannot decrypt aside, without echoing it', async () => {
    await writeFile(
      join(dir, 'secrets.encrypted.json'),
      JSON.stringify({
        version: 1,
        secrets: { cursor: Buffer.from('sk-leak').toString('base64') },
      }),
    );
    const logger = log();

    const secrets = await open(fakeKeychain(), logger);

    expect(secrets.get('cursor')).toBeUndefined();
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith('secrets.encrypted.json.corrupt-'))).toBe(true);
    expect(names).not.toContain('secrets.encrypted.json');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keychain'));
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining('sk-leak'));
  });

  test('moves an unreadable file aside', async () => {
    await writeFile(join(dir, 'secrets.encrypted.json'), '{ not json');
    const logger = log();

    const secrets = await open(fakeKeychain(), logger);

    expect(secrets.get('cursor')).toBeUndefined();
    expect(
      (await readdir(dir)).some((name) => name.startsWith('secrets.encrypted.json.corrupt-')),
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('refuses a file from a newer PR Quest instead of dropping its keys', async () => {
    const text = JSON.stringify({ version: 2, secrets: {} });
    await writeFile(join(dir, 'secrets.encrypted.json'), text);

    await expect(open(fakeKeychain())).rejects.toThrow(/newer version of PR Quest/);

    expect(await readFile(join(dir, 'secrets.encrypted.json'), 'utf8')).toBe(text);
  });
});

describe('openDesktopSecrets without the OS keychain', () => {
  test('keeps using the plain-text secrets.json and says so', async () => {
    await writePlain({ cursor: 'key_plain' });
    const logger = log();

    const secrets = await open(undefined, logger);
    await secrets.set('linear', 'lin_plain');

    expect(secrets.get('cursor')).toBe('key_plain');
    expect(await readdir(dir)).toEqual(['secrets.json']);
    expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toContain('lin_plain');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keychain'));
  });
});
