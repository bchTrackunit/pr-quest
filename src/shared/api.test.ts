import { describe, expect, test } from 'vitest';

import { API_ROUTES, buildApiPath } from './api.ts';

describe('buildApiPath', () => {
  test('returns parameterless paths unchanged', () => {
    expect(buildApiPath('listQuests', {})).toBe('/api/quests');
  });

  test('URL-encodes quest ids so owner/repo#number fits in one path segment', () => {
    expect(buildApiPath('startReview', { id: 'Trackunit/manager#26944' })).toBe(
      '/api/quests/Trackunit%2Fmanager%2326944/review',
    );
  });

  test('every route lives under /api', () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.path.startsWith('/api/')).toBe(true);
    }
  });
});
