import { describe, expect, test, vi } from 'vitest';

import { GitHubTokenProvider } from './githubToken.ts';

function provider(options: { oauth?: string; gh?: string; nowMs?: () => number } = {}) {
  const oauthToken = vi.fn(async () => options.oauth);
  const ghToken = vi.fn(async () => options.gh);
  return {
    oauthToken,
    ghToken,
    tokens: new GitHubTokenProvider({ oauthToken, ghToken, now: options.nowMs ?? (() => 0) }),
  };
}

describe('GitHubTokenProvider', () => {
  test('prefers the signed-in OAuth token and never asks gh', async () => {
    const { tokens, ghToken } = provider({ oauth: 'gho_oauth', gh: 'gho_gh' });

    await expect(tokens.resolve()).resolves.toEqual({ token: 'gho_oauth', source: 'oauth' });
    expect(ghToken).not.toHaveBeenCalled();
  });

  test('falls back to the gh token', async () => {
    const { tokens } = provider({ gh: 'gho_gh' });

    await expect(tokens.resolve()).resolves.toEqual({ token: 'gho_gh', source: 'gh' });
    await expect(tokens.token()).resolves.toBe('gho_gh');
  });

  test('resolves undefined with neither', async () => {
    await expect(provider().tokens.resolve()).resolves.toBeUndefined();
  });

  test('runs gh at most once per cache period, including when it has no token', async () => {
    let nowMs = 0;
    const { tokens, ghToken } = provider({ nowMs: () => nowMs });

    await tokens.resolve();
    await tokens.resolve();
    expect(ghToken).toHaveBeenCalledTimes(1);

    nowMs = 5 * 60_000 + 1;
    await tokens.resolve();
    expect(ghToken).toHaveBeenCalledTimes(2);
  });

  test('invalidate makes the next call ask gh again', async () => {
    const { tokens, ghToken } = provider({ gh: 'gho_gh' });

    await tokens.resolve();
    tokens.invalidate();
    await tokens.resolve();

    expect(ghToken).toHaveBeenCalledTimes(2);
  });
});
