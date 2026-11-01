import { describe, expect, test } from 'vitest';

import { externalUrl, isAllowedPermission, isAppUrl } from './navigation.ts';

const APP = 'http://127.0.0.1:53124';

describe('isAppUrl', () => {
  test.each([`${APP}/`, `${APP}/api/health`, `${APP}/?quest=1#top`])('%s is the app', (url) => {
    expect(isAppUrl(url, APP)).toBe(true);
  });

  test.each([
    'http://127.0.0.1:4318/',
    'http://localhost:53124/',
    'https://127.0.0.1:53124/',
    'https://github.com/',
    'not a url',
  ])('%s is not the app', (url) => {
    expect(isAppUrl(url, APP)).toBe(false);
  });
});

describe('externalUrl', () => {
  test.each([
    'https://github.com/octo/repo/pull/1',
    'http://example.com/',
    'mailto:someone@example.com',
  ])('opens %s in the system browser', (url) => {
    expect(externalUrl(url)).toBe(new URL(url).href);
  });

  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'smb://server/share',
    'x-apple.systempreferences:',
    'not a url',
  ])('refuses %s', (url) => {
    expect(externalUrl(url)).toBeUndefined();
  });
});

describe('isAllowedPermission', () => {
  test.each(['notifications', 'clipboard-sanitized-write'])(
    'grants %s to the app',
    (permission) => {
      expect(isAllowedPermission(permission, `${APP}/`, APP)).toBe(true);
    },
  );

  test('refuses everything else', () => {
    expect(isAllowedPermission('geolocation', `${APP}/`, APP)).toBe(false);
    expect(isAllowedPermission('media', `${APP}/`, APP)).toBe(false);
  });

  test('refuses other origins, even for notifications', () => {
    expect(isAllowedPermission('notifications', 'https://evil.example/', APP)).toBe(false);
  });
});
