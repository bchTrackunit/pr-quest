import { useId, useRef, useState } from 'react';

import type { GitHubAccount } from '../../../shared/api.ts';
import { DeviceCodePanel } from './DeviceCodePanel.tsx';
import { Modal } from '../../../platform/ui/Modal.tsx';
import { Popover, usePopoverClose } from '../../../platform/ui/Popover.tsx';
import {
  TOKEN_SOURCE_DESCRIPTIONS,
  TOKEN_SOURCE_LABELS,
  type GitHubAccountController,
} from './useGitHubAccount.ts';

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

/** Tells the player that signing out switched PR Quest to another account's gh CLI token. */
export const FallbackNotice = ({ state, actions }: GitHubAccountController) =>
  state.fallback ? (
    <div className="notice notice--warning fallback-notice" role="status">
      <p>
        Signed out of @{state.fallback.from}. PR Quest now acts as @{state.fallback.to} through your
        GitHub CLI login. Run <code>gh auth switch</code> or <code>gh auth logout</code> to change
        that.
      </p>
      <button className="button button--small" onClick={actions.dismissFallback} type="button">
        Dismiss
      </button>
    </div>
  ) : null;

interface AccountMenuProps {
  account: GitHubAccount;
  isSigningOut: boolean;
  onClickSignOut: () => void;
  onClickSettings?: () => void;
}

/** The account chip's menu: who PR Quest acts as, the token source, settings and signing out. */
const AccountMenu = ({
  account,
  isSigningOut,
  onClickSignOut,
  onClickSettings = undefined,
}: AccountMenuProps) => {
  const close = usePopoverClose();
  return (
    <>
      <div className="account__summary">
        <AccountAvatar account={account} />
        <div>
          <p className="account__name">@{account.login}</p>
          {account.name ? <p className="muted">{account.name}</p> : null}
        </div>
      </div>
      <p className="account__source">
        <TokenSourceBadge account={account} />{' '}
        <span className="muted">{TOKEN_SOURCE_DESCRIPTIONS[account.tokenSource]}</span>
      </p>
      <div className="button-row">
        {onClickSettings ? (
          <button
            className="button button--small"
            onClick={() => {
              close();
              onClickSettings();
            }}
            type="button"
          >
            <span aria-hidden="true">⚙️</span> Settings
          </button>
        ) : null}
        {account.tokenSource === 'oauth' ? (
          <button
            className="button button--small"
            disabled={isSigningOut}
            onClick={onClickSignOut}
            type="button"
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        ) : null}
      </div>
    </>
  );
};

export interface GitHubAccountControlProps extends GitHubAccountController {
  /** Adds a "Settings" entry to the account menu. */
  onClickSettings?: () => void;
}

/**
 * The header's GitHub corner: an account chip whose menu shows who PR Quest acts as and offers
 * signing out, or "Sign in with GitHub" while nobody is signed in.
 */
export const GitHubAccountControl = ({
  state,
  actions,
  onClickSettings = undefined,
}: GitHubAccountControlProps) => {
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
        <span className="muted account__unknown" title={state.loadError}>
          GitHub account unknown
        </span>
      );
    }
    if (account) {
      return (
        <div className="account" ref={accountRef} tabIndex={-1}>
          <Popover
            align="end"
            buttonClassName="button button--small account__chip"
            buttonContent={
              <>
                <AccountAvatar account={account} />
                <span className="account__login">@{account.login}</span>
                <span aria-hidden="true" className="caret">
                  ▾
                </span>
              </>
            }
            buttonLabel={`GitHub account @${account.login}`}
            label="GitHub account"
          >
            <AccountMenu
              account={account}
              isSigningOut={state.pending === 'signOut'}
              onClickSettings={onClickSettings}
              onClickSignOut={actions.signOut}
            />
          </Popover>
        </div>
      );
    }
    return (
      <div className="account" ref={accountRef} tabIndex={-1}>
        <button
          aria-describedby={state.clientIdConfigured ? undefined : setupHintId}
          className="button button--small button--primary"
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
      </div>
    );
  };

  return (
    <>
      {renderAccount()}
      {state.accountError && !account ? (
        <p className="notice notice--warning account__callout" role="status">
          GitHub rejected the token: {state.accountError}
        </p>
      ) : null}
      <FallbackNotice actions={actions} state={state} />
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
