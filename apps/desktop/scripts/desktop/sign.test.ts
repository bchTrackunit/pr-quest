import { describe, expect, it } from 'vitest';

import { nodeEntitlementsProblem } from './sign.ts';

const plist = (...keys: Array<string>): string =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${keys
    .map((key) => `<key>${key}</key><true/>`)
    .join('')}</dict></plist>`;

describe('nodeEntitlementsProblem', () => {
  it('lets a signed app give Node only JIT, which V8 needs under the hardened runtime', () => {
    expect(nodeEntitlementsProblem(plist('com.apple.security.cs.allow-jit'), true)).toBeUndefined();
  });

  it('refuses the debugging entitlements the official Node binary comes with', () => {
    const official = plist(
      'com.apple.security.cs.allow-dyld-environment-variables',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.get-task-allow',
    );
    for (const signed of [true, false]) {
      const problem = nodeEntitlementsProblem(official, signed);
      expect(problem).toMatch(/get-task-allow/);
      expect(problem).toMatch(/allow-dyld-environment-variables/);
      expect(problem).toMatch(/disable-library-validation/);
    }
  });

  it('gives an unsigned Node no entitlements at all', () => {
    expect(nodeEntitlementsProblem('', false)).toBeUndefined();
    expect(nodeEntitlementsProblem(plist(), false)).toBeUndefined();
    expect(nodeEntitlementsProblem(plist('com.apple.security.cs.allow-jit'), false)).toMatch(
      /allow-jit/,
    );
  });
});
