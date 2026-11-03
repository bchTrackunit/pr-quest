import { describe, expect, it } from 'vitest';

import {
  appImageLibrariesToStrip,
  hostTriple,
  isMachO,
  platformPackageProblem,
  targetFor,
} from './targets.ts';

describe('hostTriple', () => {
  it('names the Rust target of each machine the app is built on', () => {
    expect(hostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(hostTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(hostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(hostTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
  });

  it('refuses a machine the Cursor SDK has no build for', () => {
    expect(() => hostTriple('win32', 'arm64')).toThrow(/win32-arm64/);
  });
});

describe('targetFor', () => {
  it('pairs each target with its Node download and Cursor SDK package', () => {
    const intelMac = targetFor('x86_64-apple-darwin');
    expect(intelMac.os).toBe('macos');
    expect(intelMac.sdkPackage).toBe('@cursor/sdk-darwin-x64');
    expect(intelMac.node.archive).toBe('node-v24.22.1-darwin-x64.tar.gz');
    expect(intelMac.node.sha256).toMatch(/^[0-9a-f]{64}$/);

    const windows = targetFor('x86_64-pc-windows-msvc');
    expect(windows.node.archive).toBe('node-v24.22.1-win-x64.zip');
    expect(windows.nodeBinary).toBe('node-x86_64-pc-windows-msvc.exe');
    expect(windows.bundles).toEqual(['nsis']);

    expect(targetFor('x86_64-unknown-linux-gnu').bundles).toEqual(['appimage', 'deb']);
  });

  it('lists the targets it knows when given another', () => {
    expect(() => targetFor('riscv64gc-unknown-linux-gnu')).toThrow(/aarch64-apple-darwin/);
  });
});

describe('platformPackageProblem', () => {
  const target = targetFor('x86_64-apple-darwin');

  it('accepts exactly the target’s package', () => {
    expect(platformPackageProblem(['@cursor/sdk', '@cursor/sdk-darwin-x64'], target)).toBe(
      undefined,
    );
  });

  it('refuses a build without the target’s package', () => {
    expect(platformPackageProblem(['@cursor/sdk', '@cursor/sdk-darwin-arm64'], target)).toMatch(
      /@cursor\/sdk-darwin-x64 isn't installed/,
    );
  });

  it('refuses a build that would ship another platform’s binaries', () => {
    expect(
      platformPackageProblem(['@cursor/sdk-darwin-x64', '@cursor/sdk-darwin-arm64'], target),
    ).toMatch(/@cursor\/sdk-darwin-arm64/);
  });
});

describe('isMachO', () => {
  it('recognises thin and universal Mach-O files', () => {
    expect(isMachO(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))).toBe(true);
    expect(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0]))).toBe(true);
  });

  it('ignores scripts, ELF files and anything too short', () => {
    expect(isMachO(Buffer.from('#!/bin/sh\n'))).toBe(false);
    expect(isMachO(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(false);
    expect(isMachO(Buffer.from([0xcf]))).toBe(false);
  });
});

describe('appImageLibrariesToStrip', () => {
  it('picks the bundled libwayland-client, whichever version linuxdeploy copied', () => {
    expect(
      appImageLibrariesToStrip([
        'libwayland-client.so.0',
        'libwayland-client.so.0.22.0',
        'libwayland-cursor.so.0',
        'libgtk-3.so.0',
      ]),
    ).toEqual(['libwayland-client.so.0', 'libwayland-client.so.0.22.0']);
  });
});
