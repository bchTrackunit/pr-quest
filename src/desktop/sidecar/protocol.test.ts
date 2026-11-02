import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { parseCommand, parseLaunch, READY_PREFIX, readyLine } from './protocol.ts';

const launch = {
  requestSecret: randomBytes(32).toString('base64url'),
  bootstrapCode: randomBytes(32).toString('base64url'),
  dataKey: randomBytes(32).toString('base64'),
  preferencesFile: '/tmp/desktop.json',
};

describe('parseLaunch', () => {
  test('reads the launch message, with or without a data key', () => {
    expect(parseLaunch(JSON.stringify(launch))).toEqual(launch);
    expect(parseLaunch(JSON.stringify({ ...launch, dataKey: null })).dataKey).toBeNull();
  });

  test('names the bad fields without repeating the secrets', () => {
    const bad = { ...launch, requestSecret: 'short secret', dataKey: 'AAAA' };

    const read = () => parseLaunch(JSON.stringify(bad));

    expect(read).toThrow(/requestSecret, dataKey/);
    expect(read).not.toThrow(/short secret/);
    expect(read).not.toThrow(new RegExp(launch.bootstrapCode));
  });

  test('refuses a line that is not JSON', () => {
    expect(() => parseLaunch('not json')).toThrow(/invalid/);
  });
});

describe('parseCommand', () => {
  test('knows only the smoke test command', () => {
    expect(parseCommand('{"command":"smoke"}')).toEqual({ command: 'smoke' });
    expect(parseCommand('{"command":"exit"}')).toBeUndefined();
  });
});

test('readyLine is one prefixed JSON line', () => {
  expect(readyLine({ port: 4317, storage: 'keychain' })).toBe(
    `${READY_PREFIX}{"port":4317,"storage":"keychain"}`,
  );
});
