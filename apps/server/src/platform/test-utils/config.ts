import {
  type HostedConfig,
  LOOPBACK_HOST,
  LOOPBACK_HOSTNAMES,
  type LocalConfig,
} from '../config.ts';

/** A local-mode config on ephemeral ports; tests set `stateDir` to their own temp directory. */
export const LOCAL_CONFIG: LocalConfig = {
  mode: 'local',
  host: LOOPBACK_HOST,
  port: 0,
  uiPort: 0,
  allowedHosts: LOOPBACK_HOSTNAMES,
  stateDir: '/tmp/pr-quest-test',
};

/** A hosted-mode config behind `https://pr-quest.example`, also reachable as `pr-quest.fly.dev`. */
export const HOSTED_CONFIG: HostedConfig = {
  mode: 'hosted',
  host: '::',
  port: 0,
  uiPort: 0,
  publicOrigin: 'https://pr-quest.example',
  allowedHosts: ['pr-quest.example', 'pr-quest.fly.dev'],
  stateDir: '/tmp/pr-quest-test',
};
