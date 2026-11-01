import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.prquest.desktop',
  productName: 'PR Quest',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'dist-desktop/**/*', '!**/*.map', 'package.json'],
  asarUnpack: ['node_modules/@cursor/sdk-*/**', '**/*.node'],
  mac: { target: [{ target: 'dmg', arch: ['arm64', 'x64'] }] },
};

export default config;
