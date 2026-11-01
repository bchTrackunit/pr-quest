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
});
