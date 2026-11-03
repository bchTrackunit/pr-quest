import { describe, expect, test } from 'vitest';

import { extractCommand } from './layout.ts';

describe('extractCommand', () => {
  test("Windows uses its own bsdtar, not a GNU tar on PATH, which takes D: for a host and can't read zip", () => {
    expect(
      extractCommand('D:\\a\\cache\\node.zip', 'D:\\a\\cache', 'win32', {
        SystemRoot: 'C:\\WINDOWS',
      }),
    ).toEqual([
      'C:\\WINDOWS\\System32\\tar.exe',
      ['-xf', 'D:\\a\\cache\\node.zip', '-C', 'D:\\a\\cache'],
    ]);
    expect(extractCommand('node.zip', 'cache', 'win32', {})[0]).toBe(
      'C:\\Windows\\System32\\tar.exe',
    );
  });

  test('Linux unzips a zip, and tar takes the rest', () => {
    expect(extractCommand('node.zip', 'cache', 'linux', {})).toEqual([
      'unzip',
      ['-q', 'node.zip', '-d', 'cache'],
    ]);
    expect(extractCommand('node.tar.gz', 'cache', 'linux', {})).toEqual([
      'tar',
      ['-xf', 'node.tar.gz', '-C', 'cache'],
    ]);
    expect(extractCommand('node.tar.gz', 'cache', 'darwin', {})).toEqual([
      'tar',
      ['-xf', 'node.tar.gz', '-C', 'cache'],
    ]);
  });
});
