import type { ReactNode } from 'react';

import { ConnectionIndicator, type ConnectionStatus } from '../features/game/index.ts';

export interface HeaderControlsProps {
  connection: ConnectionStatus;
  /** The account chip, whose popout also holds the preferences and Settings. */
  account?: ReactNode;
}

/** The page's top-right corner: live status, then the account chip. */
export const HeaderControls = ({ connection, account = undefined }: HeaderControlsProps) => (
  <div aria-label="Status and account" className="header-controls" role="group">
    <ConnectionIndicator status={connection} />
    {account}
  </div>
);
