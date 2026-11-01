import type { ReactNode } from 'react';

import { ConnectionIndicator, type ConnectionStatus } from '../../features/game/ui/index.ts';
import type { NotificationAccess } from '../../platform/ui/notifications.ts';

export interface HeaderControlsProps {
  connection: ConnectionStatus;
  notificationAccess: NotificationAccess;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  onClickNotifications: () => void;
  onClickSound: () => void;
  onClickSettings: () => void;
  /** The GitHub account chip, shown last, in the corner. */
  account?: ReactNode;
}

function notificationLabel(access: NotificationAccess, enabled: boolean): string {
  switch (access) {
    case 'unsupported':
      return 'Notifications unsupported';
    case 'denied':
      return 'Notifications blocked';
    case 'default':
      return 'Enable notifications';
    default:
      return enabled ? 'Notifications on' : 'Notifications off';
  }
}

/** The page's top-right corner: live status, notification and sound toggles, settings, account. */
export const HeaderControls = ({
  connection,
  notificationAccess,
  notificationsEnabled,
  soundEnabled,
  onClickNotifications,
  onClickSound,
  onClickSettings,
  account = undefined,
}: HeaderControlsProps) => {
  const canToggleNotifications =
    notificationAccess === 'default' || notificationAccess === 'granted';
  const isNotifying = notificationAccess === 'granted' && notificationsEnabled;
  const notifications = notificationLabel(notificationAccess, notificationsEnabled);

  return (
    <div aria-label="Account and settings" className="header-controls" role="group">
      <ConnectionIndicator status={connection} />
      <button
        aria-label={notifications}
        aria-pressed={canToggleNotifications ? isNotifying : undefined}
        className="button button--small button--icon"
        disabled={!canToggleNotifications}
        onClick={onClickNotifications}
        title={
          notificationAccess === 'denied'
            ? 'Allow notifications for this site in your browser settings'
            : notifications
        }
        type="button"
      >
        <span aria-hidden="true">{isNotifying ? '🔔' : '🔕'}</span>
      </button>
      <button
        aria-label="Sound"
        aria-pressed={soundEnabled}
        className="button button--small button--icon"
        onClick={onClickSound}
        title={soundEnabled ? 'Sound on' : 'Sound off'}
        type="button"
      >
        <span aria-hidden="true">{soundEnabled ? '🔊' : '🔈'}</span>
      </button>
      <button
        aria-label="Settings"
        className="button button--small button--icon"
        onClick={onClickSettings}
        title="Settings"
        type="button"
      >
        <span aria-hidden="true">⚙️</span>
      </button>
      {account}
    </div>
  );
};
