import { useId, useRef, useState, type ReactNode } from 'react';

import type { GitHubAccount } from '@pr-quest/contract/api';
import { DeviceCodePanel } from './DeviceCodePanel.tsx';
import { Modal } from '../../platform/Modal.tsx';
import { Popover, usePopoverClose } from '../../platform/Popover.tsx';
import {
  TOKEN_SOURCE_DESCRIPTIONS,
  TOKEN_SOURCE_LABELS,
  type GitHubAccountController,
  type GitHubAccountState,
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

interface AccountSectionProps {
  state: GitHubAccountState;
  onClickSignIn: () => void;
}

/** The top of the account popout: who PR Quest acts as, or an offer to sign in. */
const AccountSection = ({ state, onClickSignIn }: AccountSectionProps) => {
  const close = usePopoverClose();
  const setupHintId = useId();
  const { account } = state;

  if (account) {
    return (
      <div className="account__section">
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
      </div>
    );
  }
  switch (state.load) {
    case 'loading':
      return <p className="muted account__section">Checking your GitHub account…</p>;
    case 'error':
      return (
        <p className="muted account__section account__unknown">
          GitHub account unknown: {state.loadError}
        </p>
      );
    case 'unavailable':
      return null;
    default:
      return (
        <div className="account__section">
          <p className="account__name">Not signed in</p>
          <p className="muted">Sign in so PR Quest reviews and approves as you.</p>
          <button
            aria-describedby={state.clientIdConfigured ? undefined : setupHintId}
            className="button button--small button--primary"
            onClick={() => {
              close();
              onClickSignIn();
            }}
            type="button"
          >
            <span aria-hidden="true">🔑</span>{' '}
            {state.device.state === 'pending' ? 'Finish signing in' : 'Sign in with GitHub'}
          </button>
          {state.clientIdConfigured ? null : (
            <span className="visually-hidden" id={setupHintId}>
              Needs PR_QUEST_GITHUB_CLIENT_ID; opens setup steps.
            </span>
          )}
        </div>
      );
  }
};

/** What the chip shows: the account, a sign-in prompt, or a plain "Account" until it's known. */
function chipFor(state: GitHubAccountState): {
  content: ReactNode;
  label?: string;
  /** Names the login too, because narrow screens show only the avatar. */
  tooltip: string;
  className: string;
} {
  const caret = (
    <span aria-hidden="true" className="caret">
      ▾
    </span>
  );
  const { account } = state;
  if (account) {
    return {
      content: (
        <>
          <AccountAvatar account={account} />
          <span className="account__login">@{account.login}</span>
          {caret}
        </>
      ),
      label: `GitHub account @${account.login}`,
      tooltip: `Account and settings for @${account.login}`,
      className: 'button button--small account__chip',
    };
  }
  if (state.load === 'ready') {
    return {
      content: (
        <>
          <span aria-hidden="true">🔑</span>{' '}
          {state.device.state === 'pending' ? 'Finish signing in' : 'Sign in'} {caret}
        </>
      ),
      tooltip: 'Sign in, preferences and settings',
      className: 'button button--small button--primary account__chip',
    };
  }
  return {
    content: (
      <>
        <span aria-hidden="true">👤</span> Account {caret}
      </>
    ),
    tooltip: 'Account and settings',
    className: 'button button--small account__chip',
  };
}

export interface GitHubAccountControlProps extends GitHubAccountController {
  /** App preferences and Settings, shown in the account popout below the account. */
  children?: ReactNode;
}

/**
 * The header's account chip. Its popout says who PR Quest acts as (or offers "Sign in with
 * GitHub"), holds the app preferences passed as children, and offers signing out. It renders in
 * every load state, so the preferences and Settings are always one click away.
 */
export const GitHubAccountControl = ({
  state,
  actions,
  children = undefined,
}: GitHubAccountControlProps) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const { account, device } = state;

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

  const chip = chipFor(state);
  const isSigningOut = state.pending === 'signOut';

  return (
    <>
      <div className="account" ref={accountRef} tabIndex={-1}>
        <Popover
          align="end"
          buttonClassName={chip.className}
          buttonContent={chip.content}
          buttonLabel={chip.label}
          buttonTooltip={chip.tooltip}
          label="Account and settings"
        >
          <AccountSection onClickSignIn={openSignIn} state={state} />
          {children}
          {account?.tokenSource === 'oauth' ? (
            <div className="popover__footer">
              <button
                className="button button--small"
                disabled={isSigningOut}
                onClick={actions.signOut}
                type="button"
              >
                {isSigningOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          ) : null}
        </Popover>
      </div>
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
