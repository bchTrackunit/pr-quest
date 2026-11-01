import { describe, expect, test } from 'vitest';

import { forbiddenSwitch } from './launchGuard.ts';

const switches =
  (...names: Array<string>) =>
  (name: string): boolean =>
    names.includes(name);

describe('forbiddenSwitch', () => {
  test.each(['remote-debugging-port', 'remote-debugging-pipe'])(
    'names %s in a packaged app, which would let any local program drive the window',
    (name) => {
      expect(forbiddenSwitch({ isPackaged: true, hasSwitch: switches(name) })).toBe(name);
    },
  );

  test('allows a packaged app started normally', () => {
    expect(forbiddenSwitch({ isPackaged: true, hasSwitch: switches() })).toBeUndefined();
  });

  test('allows debugging during development', () => {
    expect(
      forbiddenSwitch({ isPackaged: false, hasSwitch: switches('remote-debugging-port') }),
    ).toBeUndefined();
  });
});
