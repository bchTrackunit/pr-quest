/*
 * On Unix the shell starts the sidecar as the leader of a process group of its own, which what the
 * server starts, such as the Cursor SDK's cursorsandbox or a review's rg, joins. The shell kills
 * the group when the sidecar exits, unless the shell itself was killed; the sidecar then stops the
 * rest of its group itself.
 */

type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface ProcessGroup {
  /** Sends SIGTERM to the group, once; this process gets it too. */
  stopOthers: () => void;
  /** Whether `stopOthers` ran, so a SIGTERM this process gets may be its own. */
  signalledItself: () => boolean;
}

/**
 * The group this process leads, or `undefined` when it leads none, as on Windows or when it wasn't
 * started by the shell. A group whose id is this pid can only be the one it leads: an id stays
 * with its group, and isn't given to another process, until the group is gone.
 */
export function ownProcessGroup(
  pid: number = process.pid,
  kill: Kill = (target, signal) => process.kill(target, signal),
): ProcessGroup | undefined {
  try {
    kill(-pid, 0);
  } catch {
    return undefined;
  }
  let signalled = false;
  return {
    stopOthers: () => {
      if (signalled) {
        return;
      }
      signalled = true;
      try {
        kill(-pid, 'SIGTERM');
      } catch {
        // The group is gone, which is what stopping it was for.
      }
    },
    signalledItself: () => signalled,
  };
}
