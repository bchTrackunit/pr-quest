import { useId } from 'react';

import { usePopoverClose } from '../../platform/ui/Popover.tsx';
import type { NotificationAccess } from '../../platform/ui/notifications.ts';

export interface PreferencesMenuProps {
  notificationAccess: NotificationAccess;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  onClickNotifications: () => void;
  onClickSound: () => void;
  onClickSettings: () => void;
}

interface SwitchRowProps {
  icon: string;
  label: string;
  isOn: boolean;
  isDisabled?: boolean;
  hint?: string;
  onClick: () => void;
}

/** A full-width on/off switch; the label names it and `aria-checked` carries the state. */
const SwitchRow = ({
  icon,
  label,
  isOn,
  isDisabled = false,
  hint = undefined,
  onClick,
}: SwitchRowProps) => {
  const hintId = useId();
  return (
    <div className="switch-row">
      <button
        aria-checked={isOn}
        aria-describedby={hint ? hintId : undefined}
        className="switch-row__button"
        disabled={isDisabled}
        onClick={onClick}
        role="switch"
        type="button"
      >
        <span className="switch-row__label">
          <span aria-hidden="true">{icon}</span> {label}
        </span>
        <span aria-hidden="true" className="switch-row__state">
          {isOn ? 'On' : 'Off'}
        </span>
        <span aria-hidden="true" className="switch-row__track">
          <span className="switch-row__thumb" />
        </span>
      </button>
      {hint ? (
        <p className="muted switch-row__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
};

const NOTIFICATION_HINTS: Partial<Record<NotificationAccess, string>> = {
  default: 'Your browser asks for permission first.',
  denied: 'Blocked. Allow notifications for this site in your browser settings.',
  unsupported: 'This browser does not support notifications.',
};

/** The account popout's app preferences: notification and sound switches, then Settings. */
export const PreferencesMenu = ({
  notificationAccess,
  notificationsEnabled,
  soundEnabled,
  onClickNotifications,
  onClickSound,
  onClickSettings,
}: PreferencesMenuProps) => {
  const close = usePopoverClose();
  const canToggleNotifications =
    notificationAccess === 'default' || notificationAccess === 'granted';
  const isNotifying = notificationAccess === 'granted' && notificationsEnabled;

  return (
    <>
      <div aria-label="Preferences" className="preferences" role="group">
        <SwitchRow
          hint={NOTIFICATION_HINTS[notificationAccess]}
          icon={isNotifying ? '🔔' : '🔕'}
          isDisabled={!canToggleNotifications}
          isOn={isNotifying}
          label="Notifications"
          onClick={onClickNotifications}
        />
        <SwitchRow
          icon={soundEnabled ? '🔊' : '🔈'}
          isOn={soundEnabled}
          label="Sound"
          onClick={onClickSound}
        />
      </div>
      <button
        className="button button--small preferences__settings"
        onClick={() => {
          close();
          onClickSettings();
        }}
        type="button"
      >
        <span aria-hidden="true">⚙️</span> Settings
      </button>
    </>
  );
};
