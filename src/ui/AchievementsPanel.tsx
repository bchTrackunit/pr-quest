import type { AchievementStatus } from '../shared/api.ts';
import { Modal } from './Modal.tsx';

export interface AchievementsPanelProps {
  achievements: Array<AchievementStatus>;
  error?: string;
  onClickClose: () => void;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

export const AchievementsPanel = ({
  achievements,
  error = undefined,
  onClickClose,
}: AchievementsPanelProps) => {
  const unlockedCount = achievements.filter((achievement) => achievement.unlockedAt).length;
  return (
    <Modal
      className="modal--wide"
      onClickClose={onClickClose}
      title={`Achievements ${unlockedCount}/${achievements.length}`}
    >
      {error && achievements.length === 0 ? (
        <p className="form-error" role="alert">
          Achievements are unavailable: {error}
        </p>
      ) : null}
      <ul className="achievements">
        {achievements.map((achievement) => {
          const isUnlocked = achievement.unlockedAt !== undefined;
          const isHidden = !isUnlocked && achievement.secret === true;
          const hasProgress =
            !isUnlocked && achievement.target !== undefined && achievement.target > 0;
          const progress = Math.min(achievement.progress ?? 0, achievement.target ?? 0);
          return (
            <li
              className={[
                'achievement',
                isUnlocked ? 'achievement--unlocked' : 'achievement--locked',
              ].join(' ')}
              key={achievement.id}
            >
              <span aria-hidden="true" className="achievement__icon">
                {isHidden ? '❔' : achievement.icon}
              </span>
              <div className="achievement__text">
                <p className="achievement__name">
                  {isHidden ? '???' : achievement.name}{' '}
                  <span className="visually-hidden">{isUnlocked ? '(unlocked)' : '(locked)'}</span>
                </p>
                <p className="muted">
                  {isHidden ? 'A secret achievement.' : achievement.description}
                </p>
                {isUnlocked && achievement.unlockedAt ? (
                  <p className="achievement__date">
                    Unlocked{' '}
                    <time dateTime={achievement.unlockedAt}>
                      {dateFormat.format(new Date(achievement.unlockedAt))}
                    </time>
                  </p>
                ) : null}
                {hasProgress ? (
                  <div className="achievement__progress">
                    <progress
                      aria-label={`${isHidden ? 'Secret achievement' : achievement.name} progress`}
                      max={achievement.target}
                      value={progress}
                    />
                    <span>
                      {progress}/{achievement.target}
                    </span>
                  </div>
                ) : null}
              </div>
              <span className="achievement__reward">+{achievement.xpReward} XP</span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
};
