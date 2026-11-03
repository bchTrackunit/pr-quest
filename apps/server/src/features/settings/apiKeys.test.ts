import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ApiKeys } from './apiKeys.ts';
import { ApiError } from '../../platform/router.ts';
import { FileSecretStore } from '../../platform/secrets.ts';

let dir: string;
let secrets: FileSecretStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-keys-'));
  secrets = await FileSecretStore.open(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ApiKeys', () => {
  test('reports every key as unset by default', () => {
    expect(new ApiKeys({ env: {}, secrets }).statuses()).toEqual({
      cursor: { set: false },
      anthropic: { set: false },
      linear: { set: false },
    });
  });

  test('stores a key in the settings and shows only its last four characters', async () => {
    const keys = new ApiKeys({ env: {}, secrets });

    await keys.set('anthropic', '  sk-ant-api03-abcdefghWXYZ  ');

    expect(keys.get('anthropic')).toBe('sk-ant-api03-abcdefghWXYZ');
    expect(keys.status('anthropic')).toEqual({ set: true, source: 'settings', last4: 'WXYZ' });
    expect(secrets.get('anthropic')).toBe('sk-ant-api03-abcdefghWXYZ');
  });

  test('never reveals any characters of a short key', async () => {
    const keys = new ApiKeys({ env: {}, secrets });

    await keys.set('linear', 'short-key');

    expect(keys.status('linear')).toEqual({ set: true, source: 'settings' });
  });

  test('prefers an environment key and refuses to change or remove it', async () => {
    await secrets.set('cursor', 'key_from_settings_0000');
    const keys = new ApiKeys({ env: { cursor: 'key_from_env_123456' }, secrets });

    expect(keys.get('cursor')).toBe('key_from_env_123456');
    expect(keys.status('cursor')).toEqual({ set: true, source: 'env', last4: '3456' });
    await expect(keys.set('cursor', 'another_key_1234')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    await expect(keys.remove('cursor')).rejects.toBeInstanceOf(ApiError);
    expect(secrets.get('cursor')).toBe('key_from_settings_0000');
  });

  test('removes a stored key', async () => {
    const keys = new ApiKeys({ env: {}, secrets });
    await keys.set('linear', 'lin_api_1234567890');

    await keys.remove('linear');

    expect(keys.get('linear')).toBeUndefined();
    expect(keys.status('linear')).toEqual({ set: false });
  });

  test.each([
    ['empty', '   '],
    ['multi-line', 'abc\ndef'],
    ['too long', 'x'.repeat(1001)],
  ])('rejects an %s value', async (_label, value) => {
    const keys = new ApiKeys({ env: {}, secrets });

    await expect(keys.set('cursor', value)).rejects.toMatchObject({
      status: 400,
      code: 'badRequest',
    });
  });

  test('tells listeners which key changed', async () => {
    const changed: Array<string> = [];
    const keys = new ApiKeys({ env: {}, secrets, onChange: (name) => changed.push(name) });

    await keys.set('cursor', 'key_1234567890ab');
    await keys.remove('cursor');

    expect(changed).toEqual(['cursor', 'cursor']);
  });
});
