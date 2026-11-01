import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { MasterKeyring, newDataKey, openSealed, seal } from './envelope.ts';

const keyText = (): string => randomBytes(32).toString('base64');

describe('MasterKeyring', () => {
  test('wraps a data key that only the same key and context unwrap', () => {
    const keyring = MasterKeyring.fromConfig({ current: keyText() });
    const dataKey = newDataKey();

    const wrapped = keyring.wrap(dataKey, 'user:octocat');

    expect(wrapped.masterKeyId).toBe(keyring.currentId);
    expect(wrapped.wrapped.includes(dataKey)).toBe(false);
    expect(keyring.unwrap(wrapped, 'user:octocat').equals(dataKey)).toBe(true);
    expect(() => keyring.unwrap(wrapped, 'user:mallory')).toThrow(/could not be unwrapped/);
    expect(() =>
      MasterKeyring.fromConfig({ current: keyText() }).unwrap(wrapped, 'user:octocat'),
    ).toThrow(/isn't configured/);
  });

  test('derives a stable id from the key, so the same key always has the same id', () => {
    const current = keyText();

    expect(MasterKeyring.fromConfig({ current }).currentId).toBe(
      MasterKeyring.fromConfig({ current }).currentId,
    );
    expect(MasterKeyring.fromConfig({ current }).currentId).not.toBe(
      MasterKeyring.fromConfig({ current: keyText() }).currentId,
    );
    expect(MasterKeyring.fromConfig({ current }).currentId).toMatch(/^mk_[0-9a-f]{16}$/);
  });

  test('unwraps with a previous key during a rotation and says which keys need rewrapping', () => {
    const old = keyText();
    const wrapped = MasterKeyring.fromConfig({ current: old }).wrap(newDataKey(), 'user:octocat');

    const rotated = MasterKeyring.fromConfig({ current: keyText(), previous: old });

    expect(rotated.isCurrent(wrapped.masterKeyId)).toBe(false);
    expect(rotated.unwrap(wrapped, 'user:octocat')).toHaveLength(32);
    expect(rotated.isCurrent(rotated.wrap(newDataKey(), 'x').masterKeyId)).toBe(true);
  });

  test('accepts several previous keys separated by commas', () => {
    const [first, second] = [keyText(), keyText()];
    const wrapped = MasterKeyring.fromConfig({ current: first }).wrap(newDataKey(), 'c');

    const keyring = MasterKeyring.fromConfig({
      current: keyText(),
      previous: `${second}, ${first}`,
    });

    expect(keyring.unwrap(wrapped, 'c')).toHaveLength(32);
  });

  const failureOf = (current: string): string => {
    try {
      MasterKeyring.fromConfig({ current });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  };

  test.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['not base64', '!'.repeat(44)],
  ])('refuses a master key that is %s, without echoing it', (_case, current) => {
    const message = failureOf(current);

    expect(message).toMatch(/PR_QUEST_MASTER_KEY must be 32 random bytes, base64-encoded/);
    expect(message).not.toContain(current);
  });

  test('refuses an empty master key', () => {
    expect(failureOf('')).toMatch(/PR_QUEST_MASTER_KEY must be 32 random bytes/);
  });

  test('refuses a malformed previous key and names the variable', () => {
    expect(() => MasterKeyring.fromConfig({ current: keyText(), previous: 'short' })).toThrow(
      /PR_QUEST_PREVIOUS_MASTER_KEYS/,
    );
  });
});

describe('seal and openSealed', () => {
  test('round-trip a secret under a data key and context', () => {
    const key = newDataKey();

    const sealed = seal(key, 'sk-ant-secret', 'user:octocat:anthropic');

    expect(sealed.toString('latin1')).not.toContain('sk-ant-secret');
    expect(openSealed(key, sealed, 'user:octocat:anthropic')).toBe('sk-ant-secret');
  });

  test('uses a fresh nonce, so the same secret never seals to the same bytes', () => {
    const key = newDataKey();

    expect(seal(key, 'same', 'c').equals(seal(key, 'same', 'c'))).toBe(false);
  });

  test.each([
    ['another key', (sealed: Buffer) => ({ key: newDataKey(), sealed, context: 'c' })],
    ['another context', (sealed: Buffer) => ({ key: undefined, sealed, context: 'other' })],
    [
      'a flipped byte',
      (sealed: Buffer) => {
        const copy = Buffer.from(sealed);
        copy[copy.length - 1] = (copy.at(-1) ?? 0) ^ 1;
        return { key: undefined, sealed: copy, context: 'c' };
      },
    ],
    [
      'an unknown format',
      (sealed: Buffer) => {
        const copy = Buffer.from(sealed);
        copy[0] = 9;
        return { key: undefined, sealed: copy, context: 'c' };
      },
    ],
  ])('refuses to open with %s', (_case, tamper) => {
    const key = newDataKey();
    const attempt = tamper(seal(key, 'secret', 'c'));

    expect(() => openSealed(attempt.key ?? key, attempt.sealed, attempt.context)).toThrow(
      /could not be decrypted/,
    );
  });
});
