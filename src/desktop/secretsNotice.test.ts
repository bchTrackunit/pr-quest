import { describe, expect, test } from 'vitest';

import { secretsNotice } from './secretsNotice.ts';

const actions = (notice: ReturnType<typeof secretsNotice>) =>
  notice?.buttons.map((button) => button.action);

describe('secretsNotice', () => {
  test('says nothing when keys are encrypted, or unencrypted as the player chose', () => {
    expect(secretsNotice('keychain', undefined)).toBeUndefined();
    expect(secretsNotice('plaintext', true)).toBeUndefined();
  });

  test('asks once, without a keychain, whether to keep keys in memory or save them unencrypted', () => {
    const notice = secretsNotice('memory', undefined);

    expect(notice?.message).toMatch(/keychain/);
    expect(notice?.detail).toMatch(/until you quit/);
    expect(actions(notice)).toEqual(['keepInMemory', 'savePlaintext']);
    expect(secretsNotice('memory', false)).toBeUndefined();
  });

  test('warns every time encrypted keys wait for a keychain that is gone', () => {
    expect(secretsNotice('locked', false)?.message).toMatch(/keychain/);
    expect(secretsNotice('locked', true)?.detail).toMatch(/won't be saved/);
    expect(actions(secretsNotice('locked', undefined))).toEqual(['continue']);
  });

  test("offers to try again when the keychain couldn't decrypt the saved keys", () => {
    const notice = secretsNotice('undecryptable', undefined);

    expect(notice?.detail).toMatch(/replaces/);
    expect(actions(notice)).toEqual(['retry', 'continue']);
  });

  test('says a damaged file is damaged, not that the keychain failed', () => {
    const notice = secretsNotice('corrupt', undefined);

    expect(notice?.message).toMatch(/damaged/);
    expect(notice?.message).not.toMatch(/keychain/);
    expect(actions(notice)).toEqual(['retry', 'continue']);
  });

  test("offers to try again when the keys from secrets.json didn't check out in the keychain", () => {
    const notice = secretsNotice('importFailed', undefined);

    expect(notice?.detail).toMatch(/unchanged/);
    expect(actions(notice)).toEqual(['retry', 'continue']);
  });
});
