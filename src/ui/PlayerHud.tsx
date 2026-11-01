import { useState, type MouseEventHandler, type ReactNode } from 'react';

import type { AchievementStatus, PlayerState } from '../shared/api.ts';
import { AchievementsPanel } from './AchievementsPanel.tsx';
import { ConnectionIndicator } from './ConnectionIndicator.tsx';
import type { ConnectionStatus } from './gameState.ts';
import type { NotificationAccess } from './notifications.ts';
import { XpBar } from './XpBar.tsx';

export interface PlayerHudProps {
  player?: PlayerState;
  playerError?: string;
  achievements: Array<AchievementStatus>;
  achievementsError?: string;
  connection: ConnectionStatus;
  notificationAccess: NotificationAccess;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  onClickNotifications: MouseEventHandler<HTMLButtonElement>;
  onClickSound: MouseEventHandler<HTMLButtonElement>;
  /** The GitHub account corner, shown first among the controls. */
  account?: ReactNode;
  /** Shows the settings gear when set. */
  onClickSettings?: MouseEventHandler<HTMLButtonElement>;
}

const RECENT_LIMIT = 3;

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

export const PlayerHud = ({
  player = undefined,
  playerError = undefined,
  achievements,
  achievementsError = undefined,
  connection,
  notificationAccess,
  notificationsEnabled,
  soundEnabled,
  onClickNotifications,
  onClickSound,
  account = undefined,
  onClickSettings = undefined,
}: PlayerHudProps) => {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const recent = [...(player?.achievements ?? [])]
    .sort((left, right) => right.unlockedAt.localeCompare(left.unlockedAt))
    .slice(0, RECENT_LIMIT)
    .map((unlocked) => {
      const definition = achievements.find((entry) => entry.id === unlocked.id);
      return {
        id: unlocked.id,
        name: definition?.name ?? unlocked.id,
        icon: definition?.icon ?? '🏅',
      };
    });
  const unlockedCount = achievements.filter((entry) => entry.unlockedAt).length;
  const canToggleNotifications =
    notificationAccess === 'default' || notificationAccess === 'granted';
  const isNotifying = notificationAccess === 'granted' && notificationsEnabled;

  return (
    <section aria-label="Player" className="hud">
      <div className="hud__identity">
        <div
          aria-label={player ? `Level ${player.level}` : 'Level unknown'}
          className="hud__level"
          role="img"
        >
          <span className="hud__level-caption pixel">LV</span>
          <span className="hud__level-value pixel">{player?.level ?? '?'}</span>
        </div>
        <div className="hud__stats">
          {player ? (
            <XpBar
              level={player.level}
              xpForNextLevel={player.xpForNextLevel}
              xpIntoLevel={player.xpIntoLevel}
            />
          ) : (
            <p className="muted">
              {playerError ? `Player stats unavailable: ${playerError}` : 'Loading player…'}
            </p>
          )}
          <div className="hud__row">
            <span
              className={['streak', (player?.streakDays ?? 0) > 0 ? 'streak--active' : ''].join(
                ' ',
              )}
            >
              <span aria-hidden="true">🔥</span> {player?.streakDays ?? 0}-day streak
            </span>
            {recent.length > 0 ? (
              <ul aria-label="Recent achievements" className="hud__recent">
                {recent.map((entry) => (
                  <li className="hud__recent-badge" key={entry.id} title={entry.name}>
                    <span aria-hidden="true">{entry.icon}</span>
                    <span className="visually-hidden">{entry.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>

      <div className="hud__controls">
        {account}
        <button className="button" onClick={() => setIsPanelOpen(true)} type="button">
          <span aria-hidden="true">🏅</span> Achievements{' '}
          <span className="count">
            {unlockedCount}/{achievements.length}
          </span>
        </button>
        <button
          aria-pressed={canToggleNotifications ? isNotifying : undefined}
          className="button"
          disabled={!canToggleNotifications}
          onClick={onClickNotifications}
          title={
            notificationAccess === 'denied'
              ? 'Allow notifications for this site in your browser settings'
              : undefined
          }
          type="button"
        >
          <span aria-hidden="true">{isNotifying ? '🔔' : '🔕'}</span>{' '}
          {notificationLabel(notificationAccess, notificationsEnabled)}
        </button>
        <button aria-pressed={soundEnabled} className="button" onClick={onClickSound} type="button">
          <span aria-hidden="true">{soundEnabled ? '🔊' : '🔈'}</span> Sound
        </button>
        {onClickSettings ? (
          <button
            aria-label="Settings"
            className="button hud__settings"
            onClick={onClickSettings}
            title="Settings"
            type="button"
          >
            <span aria-hidden="true">⚙️</span>
          </button>
        ) : null}
        <ConnectionIndicator status={connection} />
      </div>

      {isPanelOpen ? (
        <AchievementsPanel
          achievements={achievements}
          error={achievementsError}
          onClickClose={() => setIsPanelOpen(false)}
        />
      ) : null}
    </section>
  );
};
