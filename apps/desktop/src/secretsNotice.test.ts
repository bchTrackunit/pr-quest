import { describe, expect, test, vi } from 'vitest';

import type { DesktopSecrets, SecretsStorage } from './keychainSecrets.ts';
import { type NoticeAction, openWithNotices, secretsNotice } from './secretsNotice.ts';

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

  test("says a file that doesn't decrypt with its own data key was changed, and offers no retry", () => {
    const notice = secretsNotice('undecryptable', undefined);

    expect(notice?.message).toMatch(/changed or damaged/);
    expect(notice?.detail).not.toMatch(/denied|try again/i);
    expect(notice?.detail).toMatch(/Start Over moves it aside/);
    expect(actions(notice)).toEqual(['startOver', 'continue']);
  });

  test('says a damaged file is damaged, not that the keychain failed', () => {
    const notice = secretsNotice('corrupt', undefined);

    expect(notice?.message).toMatch(/damaged/);
    expect(notice?.message).not.toMatch(/keychain/);
    expect(actions(notice)).toEqual(['retry', 'continue']);
  });

  test('offers to start over, keeping the file, when the keys were encrypted with another data key', () => {
    const notice = secretsNotice('wrongKey', undefined);

    expect(notice?.message).toMatch(/data key/);
    expect(notice?.detail).toMatch(/leaves secrets\.encrypted\.json alone/);
    expect(notice?.detail).toMatch(/Start Over moves it aside/);
    expect(actions(notice)).toEqual(['startOver', 'continue']);
  });

  test("offers to try again when the keys from secrets.json didn't check out in the keychain", () => {
    const notice = secretsNotice('importFailed', undefined);

    expect(notice?.detail).toMatch(/unchanged/);
    expect(actions(notice)).toEqual(['retry', 'continue']);
  });
});

describe('openWithNotices', () => {
  const secrets = (storage: SecretsStorage): DesktopSecrets => ({
    storage,
    store: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
  });

  /** Opens with each storage in turn, as reopening after the player's answer would. */
  const opening = (...storages: Array<SecretsStorage>) => {
    const open = vi.fn((_allowPlaintext: boolean) =>
      Promise.resolve(secrets(storages.shift() ?? 'keychain')),
    );
    return open;
  };

  const answering = (...choices: Array<NoticeAction>) =>
    vi.fn(() => Promise.resolve(choices.shift() ?? 'continue'));

  test('opens once and asks nothing when there is nothing to say', async () => {
    const open = opening('keychain');
    const ask = answering();

    const opened = await openWithNotices({
      open,
      ask,
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save: vi.fn(),
    });

    expect(opened.storage).toBe('keychain');
    expect(open).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });

  test('opens again for Try Again, until the keys read', async () => {
    const open = opening('corrupt', 'corrupt', 'keychain');
    const ask = answering('retry', 'retry');

    const opened = await openWithNotices({
      open,
      ask,
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save: vi.fn(),
    });

    expect(opened.storage).toBe('keychain');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('starts without saved keys for Continue Without Saved Keys', async () => {
    const save = vi.fn();

    const opened = await openWithNotices({
      open: opening('corrupt'),
      ask: answering('continue'),
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save,
    });

    expect(opened.storage).toBe('corrupt');
    expect(save).not.toHaveBeenCalled();
  });

  test('moves the unreadable file aside for Start Over, then opens again', async () => {
    const open = opening('wrongKey', 'keychain');
    const startOver = vi.fn(() => Promise.resolve());

    const opened = await openWithNotices({
      open,
      ask: answering('startOver'),
      plaintextChoice: undefined,
      startOver,
      save: vi.fn(),
    });

    expect(opened.storage).toBe('keychain');
    expect(startOver).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test('remembers keeping keys in memory and asks no more', async () => {
    const open = opening('memory');
    const save = vi.fn(() => Promise.resolve());

    const opened = await openWithNotices({
      open,
      ask: answering('keepInMemory'),
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save,
    });

    expect(opened.storage).toBe('memory');
    expect(save).toHaveBeenCalledWith(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('remembers saving keys unencrypted and opens again with that allowed', async () => {
    const open = opening('memory', 'plaintext');
    const save = vi.fn(() => Promise.resolve());

    const opened = await openWithNotices({
      open,
      ask: answering('savePlaintext'),
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save,
    });

    expect(opened.storage).toBe('plaintext');
    expect(save).toHaveBeenCalledWith(true);
    expect(open.mock.calls).toEqual([[false], [true]]);
  });

  test('opens with the earlier answer to saving keys unencrypted', async () => {
    const open = opening('plaintext');

    await openWithNotices({
      open,
      ask: answering(),
      plaintextChoice: true,
      startOver: vi.fn(),
      save: vi.fn(),
    });

    expect(open).toHaveBeenCalledWith(true);
  });

  test('asks nothing when notices are off, as after a restart', async () => {
    const ask = answering();

    const opened = await openWithNotices({
      open: opening('locked'),
      ask,
      plaintextChoice: undefined,
      startOver: vi.fn(),
      save: vi.fn(),
      notices: false,
    });

    expect(opened.storage).toBe('locked');
    expect(ask).not.toHaveBeenCalled();
  });
});
