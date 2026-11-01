import { LOOPBACK_HOST, LOOPBACK_HOSTNAMES, type LocalConfig } from '../config.ts';

/** A local-mode config on ephemeral ports; tests set `stateDir` to their own temp directory. */
export const LOCAL_CONFIG: LocalConfig = {
  mode: 'local',
  host: LOOPBACK_HOST,
  port: 0,
  uiPort: 0,
  allowedHosts: LOOPBACK_HOSTNAMES,
  stateDir: '/tmp/pr-quest-test',
};
