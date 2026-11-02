import { describe, expect, test } from 'vitest';

import { updateConfigProblems } from './updateConfig.ts';

const base = `owner: octocat
repo: pr-quest
provider: github
releaseType: draft
updaterCacheDirName: pr-quest-updater
`;

describe('updateConfigProblems', () => {
  test('accepts an unsigned build without a publisher', () => {
    expect(updateConfigProblems(base, { signed: false })).toEqual([]);
  });

  test('accepts a signed Windows build that names its publisher', () => {
    const signed = `${base}publisherName:\n  - CN=Jane Doe, O=Jane Doe, L=Austin, S=Texas, C=US\n`;

    expect(updateConfigProblems(signed, { signed: true })).toEqual([]);
  });

  test('accepts a quoted publisher name', () => {
    expect(
      updateConfigProblems(`${base}publisherName:\n  - 'PR Quest: Jane'\n`, { signed: true }),
    ).toEqual([]);
  });

  test('refuses a signed build without a publisher, whose updates would go unchecked', () => {
    expect(updateConfigProblems(base, { signed: true })).toEqual([
      expect.stringContaining('publisherName'),
    ]);
    expect(updateConfigProblems(`${base}publisherName: []\n`, { signed: true })).toEqual([
      expect.stringContaining('publisherName'),
    ]);
  });

  test("refuses a channel, whose update files releases don't publish", () => {
    expect(updateConfigProblems(`${base}channel: beta\n`, { signed: false })).toEqual([
      expect.stringContaining('channel'),
    ]);
  });

  test('accepts the repository the build was meant to update from', () => {
    expect(updateConfigProblems(base, { signed: false, repo: 'octocat/pr-quest' })).toEqual([]);
  });

  test.each(['someone/pr-quest', 'octocat/other'])(
    'refuses another repository than %s, which the app would install updates from',
    (repo) => {
      expect(updateConfigProblems(base, { signed: false, repo })).toEqual([
        expect.stringContaining('octocat/pr-quest'),
      ]);
    },
  );

  test('refuses a file without a provider, which no updater can use', () => {
    expect(updateConfigProblems('owner: octocat\n', { signed: false })).toEqual([
      expect.stringContaining('provider'),
    ]);
  });
});
