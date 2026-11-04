/*
 * Keeps libwayland-client out of the AppImage: the bundled copy breaks the app on Wayland desktops
 * newer than the build machine (tauri-apps/tauri#15665). The linuxdeploy that Tauri CLI 2.12
 * downloads already leaves it out, so this is a guard against an older or changed bundler.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BUILD_DIR } from './paths.ts';
import { appImageLibrariesToStrip } from './targets.ts';

interface Download {
  url: string;
  sha256: string;
}

/** From https://github.com/AppImage/appimagetool/releases/tag/1.9.1. */
const APPIMAGETOOL: Record<string, Download> = {
  x86_64: {
    url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
    sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
  },
  aarch64: {
    url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-aarch64.AppImage',
    sha256: 'f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158',
  },
};

/**
 * From https://github.com/AppImage/type2-runtime/releases/tag/20251108; appimagetool would
 * otherwise download the latest "continuous" build.
 */
const RUNTIME: Record<string, Download> = {
  x86_64: {
    url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
    sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  },
  aarch64: {
    url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-aarch64',
    sha256: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  },
};

/**
 * Takes the libraries out of `appImage` in place and resolves their names, none when it had
 * none; `resign` then runs for the repacked file, whose updater signature no longer matches.
 */
export function stripAppImage(
  appImage: string,
  arch: string,
  resign: (file: string) => void,
): Array<string> {
  const work = mkdtempSync(join(tmpdir(), 'pr-quest-appimage-'));
  try {
    execFileSync(resolve(appImage), ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    const root = join(work, 'squashfs-root');
    const lib = join(root, 'usr', 'lib');
    const strip = appImageLibrariesToStrip(readdirSync(lib));
    if (strip.length === 0) {
      return [];
    }
    for (const file of strip) {
      rmSync(join(lib, file));
    }
    const tool = pinned(APPIMAGETOOL, arch, `appimagetool-${arch}-1.9.1.AppImage`);
    const runtime = pinned(RUNTIME, arch, `appimage-runtime-${arch}-20251108`);
    execFileSync(tool, ['--no-appstream', '--runtime-file', runtime, root, appImage], {
      stdio: 'inherit',
      env: { ...process.env, ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    if (existsSync(`${appImage}.sig`)) {
      rmSync(`${appImage}.sig`);
      resign(appImage);
    }
    return strip;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Downloads `downloads[arch]` into build-tauri/cache once, checking its SHA-256. */
function pinned(downloads: Record<string, Download>, arch: string, name: string): string {
  const download = downloads[arch];
  if (download === undefined) {
    throw new Error(`Nothing to download ${name} from for ${arch}`);
  }
  const cache = join(BUILD_DIR, 'cache');
  const file = join(cache, name);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(file) || sha256(file) !== download.sha256) {
    execFileSync(
      'curl',
      ['--fail', '--location', '--silent', '--show-error', '--output', file, download.url],
      { stdio: 'inherit' },
    );
  }
  if (sha256(file) !== download.sha256) {
    rmSync(file, { force: true });
    throw new Error(`${download.url} doesn't have the pinned SHA-256 ${download.sha256}`);
  }
  chmodSync(file, 0o755);
  return file;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
