import { useState } from 'react';

import { formatElapsed } from './format.ts';
import {
  README_SIGN_IN_URL,
  type GitHubAccountActions,
  type GitHubAccountState,
} from './useGitHubAccount.ts';
import { useNow } from './useNow.ts';

export interface DeviceCodePanelProps {
  state: GitHubAccountState;
  actions: GitHubAccountActions;
}

const DEFAULT_VERIFICATION_URI = 'https://github.com/login/device';

type CopyState = 'idle' | 'copied' | 'failed';

function displayUri(uri: string): string {
  return uri.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** What to do when the server has no OAuth App client ID, so the device flow can't start. */
export const SignInSetupHelp = () => (
  <div className="notice notice--calm stack">
    <p>
      Sign in with GitHub needs a GitHub OAuth App. Set <code>PR_QUEST_GITHUB_CLIENT_ID</code> to
      the app&apos;s client ID in <code>.env.local</code>, then restart PR Quest.
    </p>
    <p>
      <a href={README_SIGN_IN_URL} rel="noopener noreferrer" target="_blank">
        How to set up sign-in (README)
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </p>
    <p className="muted">
      Until then PR Quest uses your GitHub CLI login (<code>gh auth login</code>).
    </p>
  </div>
);

const ExpiryCountdown = ({ expiresAt }: { expiresAt: string }) => {
  const now = useNow(1000);
  return (
    <span className="device-flow__expiry">
      Code expires in{' '}
      <time dateTime={expiresAt}>{formatElapsed(Date.parse(expiresAt) - now)}</time>
    </span>
  );
};

/** The device flow from start to finish: the code to enter on GitHub, its progress and retries. */
export const DeviceCodePanel = ({ state, actions }: DeviceCodePanelProps) => {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const { device, pending } = state;
  const isStarting = pending === 'start';
  const isCancelling = pending === 'cancel';

  if (!state.clientIdConfigured) {
    return <SignInSetupHelp />;
  }

  const copyCode = (code: string): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      setCopyState('failed');
      return;
    }
    clipboard.writeText(code).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  };

  const retryButton = (label: string) => (
    <button
      className="button button--primary"
      disabled={isStarting}
      onClick={() => {
        setCopyState('idle');
        actions.startSignIn();
      }}
      type="button"
    >
      {isStarting ? 'Asking GitHub…' : label}
    </button>
  );

  const statusText = (): string => {
    if (isStarting) {
      return 'Asking GitHub for a sign-in code…';
    }
    switch (device.state) {
      case 'pending':
        return 'Waiting for you to enter the code on GitHub…';
      case 'complete':
        return state.account ? `Signed in as @${state.account.login}.` : 'Signed in.';
      case 'expired':
        return 'The code expired before it was entered.';
      case 'denied':
        return 'Sign-in was denied on GitHub.';
      case 'error':
        return `Sign-in failed: ${device.error ?? 'unknown error'}`;
      default:
        return '';
    }
  };

  const renderBody = () => {
    if (device.state === 'pending' && device.userCode && !isStarting) {
      const verificationUri = device.verificationUri ?? DEFAULT_VERIFICATION_URI;
      return (
        <>
          <p>Enter this code on GitHub to let PR Quest act as you:</p>
          <p aria-label={`Sign-in code ${device.userCode}`} className="device-code pixel">
            {device.userCode}
          </p>
          <div className="button-row">
            <button
              className="button"
              data-autofocus
              onClick={() => copyCode(device.userCode ?? '')}
              type="button"
            >
              <span aria-hidden="true">📋</span> Copy code
            </button>
            <a
              className="button button--primary"
              href={verificationUri}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open {displayUri(verificationUri)}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
            <button
              className="button"
              disabled={isCancelling}
              onClick={actions.cancelSignIn}
              type="button"
            >
              {isCancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
          <p className="muted" role="status">
            {copyState === 'copied' ? 'Code copied.' : null}
            {copyState === 'failed' ? 'Copying failed; select the code and copy it.' : null}
          </p>
          {device.expiresAt ? <ExpiryCountdown expiresAt={device.expiresAt} /> : null}
          {state.pollError ? (
            <p className="muted">Lost contact with PR Quest ({state.pollError}); retrying…</p>
          ) : null}
        </>
      );
    }
    if (device.state === 'expired' || device.state === 'denied' || device.state === 'error') {
      return <div className="button-row">{retryButton('Try again')}</div>;
    }
    if (device.state === 'complete' || isStarting) {
      return null;
    }
    return <div className="button-row">{retryButton('Sign in with GitHub')}</div>;
  };

  return (
    <div className="device-flow stack">
      <p
        className={[
          'device-flow__status',
          device.state === 'complete' ? 'device-flow__status--done' : '',
          ['expired', 'denied', 'error'].includes(device.state) && !isStarting
            ? 'device-flow__status--failed'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="status"
      >
        {statusText()}
      </p>
      {renderBody()}
      {state.actionError ? (
        <p className="form-error" role="alert">
          {state.actionError}
        </p>
      ) : null}
    </div>
  );
};
