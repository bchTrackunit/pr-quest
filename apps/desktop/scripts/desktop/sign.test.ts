import { describe, expect, it } from 'vitest';

import { nodeSignatureProblem } from './sign.ts';

const plist = (...keys: Array<string>): string =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${keys
    .map((key) => `<key>${key}</key><true/>`)
    .join('')}</dict></plist>`;

const JIT = 'com.apple.security.cs.allow-jit';
const NO_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
const SIGNED = '0x10000(runtime)';
const AD_HOC = '0x10002(adhoc,runtime)';

describe('nodeSignatureProblem', () => {
  it('lets a signed app give Node only JIT, which V8 needs under the hardened runtime', () => {
    expect(nodeSignatureProblem({ entitlements: plist(JIT), flags: SIGNED }, true)).toBeUndefined();
  });

  it('lets an ad-hoc signed Node also load native modules without a Team ID', () => {
    expect(
      nodeSignatureProblem(
        { entitlements: plist(JIT, NO_LIBRARY_VALIDATION), flags: AD_HOC },
        false,
      ),
    ).toBeUndefined();
    expect(
      nodeSignatureProblem(
        { entitlements: plist(JIT, NO_LIBRARY_VALIDATION), flags: SIGNED },
        true,
      ),
    ).toMatch(/must not have: com\.apple\.security\.cs\.disable-library-validation/);
  });

  it('refuses the debugging entitlements the official Node binary comes with', () => {
    const official = plist(
      'com.apple.security.cs.allow-dyld-environment-variables',
      JIT,
      NO_LIBRARY_VALIDATION,
      'com.apple.security.get-task-allow',
    );
    for (const signed of [true, false]) {
      const problem = nodeSignatureProblem({ entitlements: official, flags: AD_HOC }, signed);
      expect(problem).toMatch(/get-task-allow/);
      expect(problem).toMatch(/allow-dyld-environment-variables/);
    }
  });

  it('needs the hardened runtime, signed or not', () => {
    expect(
      nodeSignatureProblem(
        { entitlements: plist(JIT, NO_LIBRARY_VALIDATION), flags: '0x2(adhoc)' },
        false,
      ),
    ).toMatch(/no hardened runtime \(flags 0x2\(adhoc\)\)/);
    expect(nodeSignatureProblem({ entitlements: plist(JIT), flags: '' }, true)).toMatch(
      /no hardened runtime \(flags none\)/,
    );
  });

  it('needs the entitlements Node runs with', () => {
    expect(nodeSignatureProblem({ entitlements: '', flags: AD_HOC }, false)).toMatch(
      /needs: com\.apple\.security\.cs\.allow-jit, com\.apple\.security\.cs\.disable-library-validation/,
    );
    expect(nodeSignatureProblem({ entitlements: plist(), flags: SIGNED }, true)).toMatch(
      /needs: com\.apple\.security\.cs\.allow-jit/,
    );
  });
});
