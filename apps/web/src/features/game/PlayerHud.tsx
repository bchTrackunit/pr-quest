import { useState } from 'react';

import type { AchievementStatus, PlayerState } from '@pr-quest/contract/api';
import { Tooltip } from '../../platform/Tooltip.tsx';
import { AchievementsPanel } from './AchievementsPanel.tsx';
import { XpBar } from './XpBar.tsx';

export interface PlayerHudProps {
  player?: PlayerState;
  playerError?: string;
  achievements: Array<AchievementStatus>;
  achievementsError?: string;
}

const RECENT_LIMIT = 3;

/** The player's game info: level, XP, streak and achievements. */
export const PlayerHud = ({
  player = undefined,
  playerError = undefined,
  achievements,
  achievementsError = undefined,
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

  return (
    <section aria-label="Player" className="hud">
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
            className={['streak', (player?.streakDays ?? 0) > 0 ? 'streak--active' : ''].join(' ')}
          >
            <span aria-hidden="true">🔥</span> {player?.streakDays ?? 0}-day streak
          </span>
          {recent.length > 0 ? (
            <ul aria-label="Recent achievements" className="hud__recent">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <Tooltip content={entry.name}>
                    {() => (
                      <span aria-label={entry.name} className="hud__recent-badge" role="img">
                        {entry.icon}
                      </span>
                    )}
                  </Tooltip>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            className="button button--small hud__achievements"
            onClick={() => setIsPanelOpen(true)}
            type="button"
          >
            <span aria-hidden="true">🏅</span> Achievements{' '}
            <span className="count">
              {unlockedCount}/{achievements.length}
            </span>
          </button>
        </div>
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
