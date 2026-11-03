/*
 * The platforms the desktop app is packaged for: the Node each one bundles, pinned by SHA-256,
 * the Cursor SDK platform package it ships, and the bundles `tauri build` makes for it.
 */

/** The Node the sidecar runs on; keep it on the `volta` pin in package.json. */
export const NODE_VERSION = '24.22.1';

export type Os = 'macos' | 'linux' | 'windows';

/**
 * The bundled Node's name, without the target triple. Not `node`: the deb installs it into
 * /usr/bin, where it would shadow the system's Node.
 */
export const SIDECAR_NODE = 'pr-quest-node';

export interface Target {
  triple: string;
  os: Os;
  /** The `<platform>-<arch>` Node and npm packages use. */
  platformKey: string;
  sdkPackage: string;
  node: { archive: string; sha256: string };
  /** The name tauri.conf.json's `binaries/pr-quest-node` externalBin has for this target. */
  nodeBinary: string;
  /** What `tauri build --bundles` makes. macOS makes the dmg from the app in a second step. */
  bundles: ReadonlyArray<string>;
}

/** The SHA-256 values are from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt. */
const TARGETS: ReadonlyArray<Target> = [
  macos('aarch64', 'arm64', '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7'),
  macos('x86_64', 'x64', 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035'),
  linux('x86_64', 'x64', 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'),
  linux('aarch64', 'arm64', '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'),
  {
    triple: 'x86_64-pc-windows-msvc',
    os: 'windows',
    platformKey: 'win32-x64',
    sdkPackage: '@cursor/sdk-win32-x64',
    node: {
      archive: `node-v${NODE_VERSION}-win-x64.zip`,
      sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
    },
    nodeBinary: `${SIDECAR_NODE}-x86_64-pc-windows-msvc.exe`,
    bundles: ['nsis'],
  },
];

function macos(arch: string, nodeArch: string, sha256: string): Target {
  return unix(`${arch}-apple-darwin`, 'macos', 'darwin', nodeArch, sha256, ['app']);
}

function linux(arch: string, nodeArch: string, sha256: string): Target {
  return unix(`${arch}-unknown-linux-gnu`, 'linux', 'linux', nodeArch, sha256, ['appimage', 'deb']);
}

function unix(
  triple: string,
  os: Os,
  platform: string,
  nodeArch: string,
  sha256: string,
  bundles: ReadonlyArray<string>,
): Target {
  return {
    triple,
    os,
    platformKey: `${platform}-${nodeArch}`,
    sdkPackage: `@cursor/sdk-${platform}-${nodeArch}`,
    node: { archive: `node-v${NODE_VERSION}-${platform}-${nodeArch}.tar.gz`, sha256 },
    nodeBinary: `${SIDECAR_NODE}-${triple}`,
    bundles,
  };
}

export function targetFor(triple: string): Target {
  const target = TARGETS.find((candidate) => candidate.triple === triple);
  if (target === undefined) {
    const known = TARGETS.map((candidate) => candidate.triple).join(', ');
    throw new Error(`PR Quest isn't packaged for ${triple}; it is for ${known}`);
  }
  return target;
}

/** The target of the machine this runs on, as `process.platform` and `process.arch` name it. */
export function hostTriple(platform: string, arch: string): string {
  const key = `${platform}-${arch}`;
  const target = TARGETS.find((candidate) => candidate.platformKey === key);
  if (target === undefined) {
    throw new Error(`PR Quest isn't packaged for ${key}`);
  }
  return target.triple;
}

/**
 * Why the Cursor SDK platform packages in a layout don't fit `target`, if they don't: it needs
 * exactly the target's, since another platform's native binaries would only fail at run time.
 */
export function platformPackageProblem(
  packages: ReadonlyArray<string>,
  target: Target,
): string | undefined {
  const platformPackages = packages.filter((name) => name.startsWith('@cursor/sdk-'));
  if (!platformPackages.includes(target.sdkPackage)) {
    return (
      `${target.sdkPackage} isn't installed, so ${target.triple} would have no Cursor SDK ` +
      `binaries; install it (see the README's desktop section) and package again`
    );
  }
  const foreign = platformPackages.filter((name) => name !== target.sdkPackage);
  if (foreign.length > 0) {
    return `the ${target.triple} layout has another platform's Cursor SDK: ${foreign.join(', ')}`;
  }
  return undefined;
}

const MACH_O_MAGIC = new Set([
  0xfeedfacf, // 64-bit
  0xcffaedfe, // 64-bit, byte-swapped
  0xfeedface, // 32-bit
  0xcefaedfe, // 32-bit, byte-swapped
  0xcafebabe, // universal
]);

/** Whether a file starting with `head` is Mach-O code, which macOS signing has to cover. */
export function isMachO(head: Uint8Array): boolean {
  if (head.length < 4) {
    return false;
  }
  return MACH_O_MAGIC.has(Buffer.from(head).readUInt32BE(0));
}

/**
 * The libraries to take out of the AppImage: its own libwayland-client breaks the window on
 * newer Wayland compositors (tauri-apps/tauri#15665), and every system with Wayland has one.
 */
export function appImageLibrariesToStrip(files: ReadonlyArray<string>): Array<string> {
  return files.filter((file) => /^libwayland-client\.so(\.|$)/.test(file));
}
