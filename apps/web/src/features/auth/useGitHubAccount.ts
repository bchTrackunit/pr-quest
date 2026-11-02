import { useEffect, useEffectEvent, useMemo, useState } from 'react';

import type {
  AuthStatusResponse,
  DeviceFlowStatus,
  GitHubAccount,
  GitHubTokenSource,
} from '@pr-quest/contract/api';
import {
  ApiRequestError,
  cancelDeviceFlow,
  describeError,
  fetchAuthStatus,
  fetchDeviceFlow,
  signOut,
  startDeviceFlow,
} from '../../platform/apiClient.ts';

/** `unavailable`: this server has no auth routes yet, so the UI hides sign-in. */
export type AccountLoad = 'loading' | 'ready' | 'unavailable' | 'error';

export type AccountPending = 'start' | 'cancel' | 'signOut';

export interface GitHubAccountState {
  load: AccountLoad;
  loadError?: string;
  clientIdConfigured: boolean;
  account?: GitHubAccount;
  /** Why the token didn't resolve to a user, e.g. GitHub rejected it. */
  accountError?: string;
  device: DeviceFlowStatus;
  pending?: AccountPending;
  actionError?: string;
  /** The last status poll failed; polling carries on. */
  pollError?: string;
  /** Signing out left PR Quest acting as a different account through the gh CLI's token. */
  fallback?: { from: string; to: string };
}

export interface GitHubAccountActions {
  /** Starts "Sign in with GitHub", or restarts it after it expired, was denied or failed. */
  startSignIn: () => void;
  cancelSignIn: () => void;
  signOut: () => void;
  dismissFallback: () => void;
}

export interface GitHubAccountController {
  state: GitHubAccountState;
  actions: GitHubAccountActions;
}

/** The server polls GitHub; this only reads the server's copy, so it can be frequent. */
export const DEVICE_POLL_MS = 2000;

export const TOKEN_SOURCE_LABELS: Record<GitHubTokenSource, string> = {
  oauth: 'OAuth',
  gh: 'gh CLI',
};

export const TOKEN_SOURCE_DESCRIPTIONS: Record<GitHubTokenSource, string> = {
  oauth: 'Signed in with GitHub (OAuth)',
  gh: 'Using the GitHub CLI login (gh fallback)',
};

export const README_SIGN_IN_URL = 'https://github.com/bchTrackunit/pr-quest#sign-in-with-github';

const INITIAL_STATE: GitHubAccountState = {
  load: 'loading',
  clientIdConfigured: true,
  device: { state: 'idle' },
};

function isUnsupported(reason: unknown): boolean {
  return (
    reason instanceof ApiRequestError &&
    (reason.code === 'notImplemented' || reason.status === 404 || reason.status === 501)
  );
}

function withStatus(state: GitHubAccountState, status: AuthStatusResponse): GitHubAccountState {
  return {
    ...state,
    load: 'ready',
    loadError: undefined,
    clientIdConfigured: status.clientIdConfigured,
    account: status.account,
    accountError: status.error,
    device: status.device,
  };
}

/**
 * After signing out, the gh CLI's token can belong to someone else. Servers that report it say
 * who was signed out in `fellBackFrom`; otherwise the login shown before signing out is used.
 */
function fallbackAfterSignOut(
  previous: GitHubAccount | undefined,
  status: AuthStatusResponse,
): GitHubAccountState['fallback'] {
  const reported =
    'fellBackFrom' in status && typeof status.fellBackFrom === 'string'
      ? status.fellBackFrom
      : undefined;
  const from = reported ?? previous?.login;
  const to = status.account;
  if (!from || to?.tokenSource !== 'gh' || to.login.toLowerCase() === from.toLowerCase()) {
    return undefined;
  }
  return { from, to: to.login };
}

/**
 * The GitHub account PR Quest acts as, and "Sign in with GitHub" through the device flow.
 * `onAccountChanged` runs after signing in or out, because the server then serves another
 * player's game.
 */
export function useGitHubAccount(onAccountChanged: () => void): GitHubAccountController {
  const [state, setState] = useState<GitHubAccountState>(INITIAL_STATE);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [accountChanges, setAccountChanges] = useState(0);
  const notifyAccountChanged = useEffectEvent(onAccountChanged);

  useEffect(() => {
    if (accountChanges > 0) {
      notifyAccountChanged();
    }
  }, [accountChanges]);

  useEffect(() => {
    const abort = new AbortController();
    fetchAuthStatus(abort.signal)
      .then((status) => setState((current) => withStatus(current, status)))
      .catch((reason: unknown) => {
        if (abort.signal.aborted) {
          return;
        }
        setState((current) =>
          isUnsupported(reason)
            ? { ...current, load: 'unavailable' }
            : { ...current, load: 'error', loadError: describeError(reason) },
        );
      });
    return () => abort.abort();
  }, []);

  const { device } = state;
  useEffect(() => {
    if (device.state !== 'pending') {
      return undefined;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (device.expiresAt && Date.parse(device.expiresAt) <= Date.now()) {
        setState((current) => ({ ...current, device: { state: 'expired' } }));
        return;
      }
      fetchDeviceFlow(abort.signal)
        .then(async (response) => {
          if (response.device.state !== 'complete') {
            setState((current) => ({ ...current, device: response.device, pollError: undefined }));
            return;
          }
          const status = await fetchAuthStatus(abort.signal);
          setState((current) => ({
            ...withStatus(current, status),
            device: response.device,
            pollError: undefined,
          }));
          setAccountChanges((count) => count + 1);
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) {
            return;
          }
          setState((current) => ({ ...current, pollError: describeError(reason) }));
          setPollAttempt((attempt) => attempt + 1);
        });
    }, DEVICE_POLL_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [device, pollAttempt]);

  const actions = useMemo<GitHubAccountActions>(
    () => ({
      startSignIn: () => {
        setState((current) => ({
          ...current,
          pending: 'start',
          actionError: undefined,
          fallback: undefined,
        }));
        startDeviceFlow()
          .then((response) =>
            setState((current) => ({
              ...current,
              pending: undefined,
              device: response.device,
              pollError: undefined,
            })),
          )
          .catch((reason: unknown) =>
            setState((current) => ({
              ...current,
              pending: undefined,
              clientIdConfigured:
                reason instanceof ApiRequestError && reason.code === 'missingConfig'
                  ? false
                  : current.clientIdConfigured,
              actionError: describeError(reason),
            })),
          );
      },
      cancelSignIn: () => {
        setState((current) => ({ ...current, pending: 'cancel', actionError: undefined }));
        cancelDeviceFlow()
          .then((response) =>
            setState((current) => ({ ...current, pending: undefined, device: response.device })),
          )
          .catch((reason: unknown) =>
            setState((current) => ({
              ...current,
              pending: undefined,
              actionError: describeError(reason),
            })),
          );
      },
      signOut: () => {
        setState((current) => ({ ...current, pending: 'signOut', actionError: undefined }));
        signOut()
          .then((status) => {
            setState((current) => ({
              ...withStatus(current, status),
              pending: undefined,
              fallback: fallbackAfterSignOut(current.account, status),
            }));
            setAccountChanges((count) => count + 1);
          })
          .catch((reason: unknown) =>
            setState((current) => ({
              ...current,
              pending: undefined,
              actionError: describeError(reason),
            })),
          );
      },
      dismissFallback: () => setState((current) => ({ ...current, fallback: undefined })),
    }),
    [],
  );

  return { state, actions };
}
