import { describe, expect, test } from 'vitest';

import { isPublishable, publishSettings } from './release.ts';

const real = { owner: 'octocat', repo: 'pr-quest' };
const placeholder = { owner: 'CHANGE-ME', repo: 'pr-quest' };

describe('isPublishable', () => {
  test('accepts a GitHub owner and repository name', () => {
    expect(isPublishable(real)).toBe(true);
  });

  test.each([
    ['the placeholder owner', placeholder],
    ['the placeholder owner in lower case', { owner: 'change-me', repo: 'pr-quest' }],
    ['an empty owner', { owner: '', repo: 'pr-quest' }],
    ['an owner with a slash', { owner: 'octo/cat', repo: 'pr-quest' }],
    ['an empty repository', { owner: 'octocat', repo: '' }],
  ])('refuses %s', (_name, repo) => {
    expect(isPublishable(repo)).toBe(false);
  });
});

describe('publishSettings', () => {
  test('publishes nothing from a local build, so it writes no update settings either', () => {
    expect(publishSettings({ releaseBuild: false, repo: real })).toBeNull();
    expect(publishSettings({ releaseBuild: false, repo: placeholder })).toBeNull();
  });

  test('publishes a release build to draft GitHub releases of the repository', () => {
    expect(publishSettings({ releaseBuild: true, repo: real })).toEqual({
      provider: 'github',
      owner: 'octocat',
      repo: 'pr-quest',
      releaseType: 'draft',
    });
  });

  test('refuses a release build of the placeholder repository', () => {
    expect(() => publishSettings({ releaseBuild: true, repo: placeholder })).toThrow(
      /RELEASE_REPO/,
    );
  });
});
