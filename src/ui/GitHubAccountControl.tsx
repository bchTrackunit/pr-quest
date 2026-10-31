import { useId, useRef, useState } from 'react';

import type { GitHubAccount } from '../shared/api.ts';
import { DeviceCodePanel } from './DeviceCodePanel.tsx';
import { Modal } from './Modal.tsx';
import {
  TOKEN_SOURCE_DESCRIPTIONS,
  TOKEN_SOURCE_LABELS,
  type GitHubAccountController,
} from './useGitHubAccount.ts';

export type GitHubAccountControlProps = GitHubAccountController;

export const AccountAvatar = ({ account }: { account: GitHubAccount }) =>
  account.avatarUrl ? (
    <img
      alt=""
      className="avatar"
      height={28}
      referrerPolicy="no-referrer"
      src={account.avatarUrl}
      width={28}
    />
  ) : (
    <span aria-hidden="true" className="avatar avatar--initial pixel">
      {account.login.slice(0, 1).toUpperCase()}
    </span>
  );

export const TokenSourceBadge = ({ account }: { account: GitHubAccount }) => (
  <span
    className={['badge', 'badge--source', `badge--source-${account.tokenSource}`].join(' ')}
    title={TOKEN_SOURCE_DESCRIPTIONS[account.tokenSource]}
  >
    <span className="visually-hidden">Token source: </span>
    {TOKEN_SOURCE_LABELS[account.tokenSource]}
  </span>
);

/** The HUD's GitHub corner: who PR Quest acts as, "Sign in with GitHub" and signing out. */
export const GitHubAccountControl = ({ state, actions }: GitHubAccountControlProps) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const setupHintId = useId();
  const accountRef = useRef<HTMLDivElement>(null);
  const { account, device } = state;

  if (state.load === 'loading' || state.load === 'unavailable') {
    return null;
  }

  /** Signing in replaces the button that opened the dialog, so focus goes to the account. */
  const accountFocusTarget = (): HTMLElement | null =>
    accountRef.current?.querySelector<HTMLElement>('button:not([disabled])') ?? accountRef.current;

  const openSignIn = (): void => {
    const canRestart = device.state !== 'pending' && state.pending !== 'start';
    if (state.clientIdConfigured && canRestart) {
      actions.startSignIn();
    }
    setIsDialogOpen(true);
  };

  const renderAccount = () => {
    if (state.load === 'error') {
      return (
        <span className="muted" title={state.loadError}>
          GitHub account unknown
        </span>
      );
    }
    if (account) {
      return (
        <div className="hud__account" ref={accountRef} tabIndex={-1}>
          <AccountAvatar account={account} />
          <span className="hud__login">
            <span className="visually-hidden">Signed in to GitHub as </span>@{account.login}
          </span>
          <TokenSourceBadge account={account} />
          {account.tokenSource === 'oauth' ? (
            <button
              className="button button--small"
              disabled={state.pending === 'signOut'}
              onClick={actions.signOut}
              type="button"
            >
              {state.pending === 'signOut' ? 'Signing out…' : 'Sign out'}
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="hud__account" ref={accountRef} tabIndex={-1}>
        <button
          aria-describedby={state.clientIdConfigured ? undefined : setupHintId}
          className="button button--primary"
          onClick={openSignIn}
          type="button"
        >
          <span aria-hidden="true">🔑</span>{' '}
          {device.state === 'pending' ? 'Finish signing in' : 'Sign in with GitHub'}
        </button>
        {state.clientIdConfigured ? null : (
          <span className="visually-hidden" id={setupHintId}>
            Needs PR_QUEST_GITHUB_CLIENT_ID; opens setup steps.
          </span>
        )}
        {state.accountError ? (
          <span className="muted hud__account-error">
            GitHub rejected the token: {state.accountError}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {renderAccount()}
      {isDialogOpen ? (
        <Modal
          onClickClose={() => setIsDialogOpen(false)}
          returnFocusTo={accountFocusTarget}
          title="Sign in with GitHub"
        >
          <DeviceCodePanel actions={actions} state={state} />
          {device.state === 'complete' ? (
            <div className="button-row button-row--end">
              <button
                autoFocus
                className="button button--success"
                data-autofocus
                onClick={() => setIsDialogOpen(false)}
                type="button"
              >
                Done
              </button>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
};
