import type {
  AchievementCategory,
  AchievementSeries,
  AchievementStatus,
} from '@pr-quest/contract/api';
import { Modal } from '../../platform/Modal.tsx';
import { CATEGORY_LABELS, CATEGORY_ORDER, RARITY_LABELS } from './achievementLabels.ts';

export interface AchievementsPanelProps {
  achievements: Array<AchievementStatus>;
  error?: string;
  onClickClose: () => void;
}

type Row =
  | { kind: 'single'; achievement: AchievementStatus }
  | {
      kind: 'series';
      series: Pick<AchievementSeries, 'id' | 'name'>;
      tiers: Array<AchievementStatus>;
    };

interface Group {
  category: AchievementCategory | 'other';
  rows: Array<Row>;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

/** Groups by category in a fixed order; the tiers of a series share one row. */
function groupAchievements(achievements: ReadonlyArray<AchievementStatus>): Array<Group> {
  const groups = new Map<Group['category'], Group>();
  for (const achievement of achievements) {
    const category = achievement.category ?? 'other';
    let group = groups.get(category);
    if (!group) {
      group = { category, rows: [] };
      groups.set(category, group);
    }
    const { series } = achievement;
    const seriesRow = series
      ? group.rows.find((row) => row.kind === 'series' && row.series.id === series.id)
      : undefined;
    if (seriesRow?.kind === 'series') {
      seriesRow.tiers.push(achievement);
    } else if (series) {
      group.rows.push({ kind: 'series', series, tiers: [achievement] });
    } else {
      group.rows.push({ kind: 'single', achievement });
    }
  }
  const order: Array<Group['category']> = [...CATEGORY_ORDER, 'other'];
  return [...groups.values()].sort(
    (left, right) => order.indexOf(left.category) - order.indexOf(right.category),
  );
}

const isUnlocked = (achievement: AchievementStatus): boolean =>
  achievement.unlockedAt !== undefined;

const UnlockedDate = ({ prefix, unlockedAt }: { prefix: string; unlockedAt: string }) => (
  <p className="achievement__date">
    {prefix} <time dateTime={unlockedAt}>{dateFormat.format(new Date(unlockedAt))}</time>
  </p>
);

const Reward = ({ achievement }: { achievement: AchievementStatus }) => (
  <div className="achievement__reward">
    {achievement.rarity ? (
      <span className={`rarity rarity--${achievement.rarity}`}>
        {RARITY_LABELS[achievement.rarity]}
      </span>
    ) : null}
    <span>+{achievement.xpReward} XP</span>
  </div>
);

const Progress = ({
  label,
  achievement,
  suffix = '',
}: {
  label: string;
  achievement: AchievementStatus;
  suffix?: string;
}) => {
  const target = achievement.target ?? 0;
  const progress = Math.min(achievement.progress ?? 0, target);
  const today = achievement.daily ? ' today' : '';
  return (
    <div className="achievement__progress">
      <progress aria-label={`${label} progress`} max={target} value={progress} />
      <span>
        {progress}/{target}
        {today}
        {suffix}
      </span>
    </div>
  );
};

const SingleRow = ({ achievement }: { achievement: AchievementStatus }) => {
  const unlocked = isUnlocked(achievement);
  const isHidden = !unlocked && achievement.secret === true;
  const name = isHidden ? '???' : achievement.name;
  const hasProgress = !unlocked && achievement.target !== undefined && achievement.target > 0;
  return (
    <li
      className={['achievement', unlocked ? 'achievement--unlocked' : 'achievement--locked'].join(
        ' ',
      )}
    >
      <span aria-hidden="true" className="achievement__icon">
        {isHidden ? '❔' : achievement.icon}
      </span>
      <div className="achievement__text">
        <p className="achievement__name">
          {name} <span className="visually-hidden">{unlocked ? '(unlocked)' : '(locked)'}</span>
        </p>
        <p className="muted">
          {isHidden ? (achievement.hint ?? 'A secret achievement.') : achievement.description}
        </p>
        {unlocked && achievement.unlockedAt ? (
          <UnlockedDate prefix="Unlocked" unlockedAt={achievement.unlockedAt} />
        ) : null}
        {hasProgress ? (
          <Progress achievement={achievement} label={isHidden ? 'Secret achievement' : name} />
        ) : null}
      </div>
      <Reward achievement={achievement} />
    </li>
  );
};

/** One row for all tiers: what's done, the next tier's goal and the progress toward it. */
const SeriesRow = ({
  series,
  tiers,
}: {
  series: Pick<AchievementSeries, 'name'>;
  tiers: Array<AchievementStatus>;
}) => {
  const next = tiers.find((tier) => !isUnlocked(tier));
  const reached = tiers.filter(isUnlocked);
  const latest = reached.at(-1);
  const current = next ?? latest;
  const tierName = (tier: AchievementStatus): string => tier.name.replace(`${series.name} `, '');
  return (
    <li
      className={[
        'achievement',
        'achievement--series',
        latest ? 'achievement--unlocked' : 'achievement--locked',
      ].join(' ')}
    >
      <span aria-hidden="true" className="achievement__icon">
        {tiers[0]?.icon}
      </span>
      <div className="achievement__text">
        <p className="achievement__name">
          {series.name}{' '}
          <span className="visually-hidden">
            {latest ? `(${tierName(latest)} unlocked)` : '(locked)'}
          </span>
        </p>
        {current ? <p className="muted">{current.description}</p> : null}
        <ol aria-label={`${series.name} tiers`} className="achievement__tiers">
          {tiers.map((tier) => (
            <li
              className={['tier', isUnlocked(tier) ? 'tier--unlocked' : 'tier--locked'].join(' ')}
              key={tier.id}
            >
              <span className="tier__name">
                {isUnlocked(tier) ? <span aria-hidden="true">✓ </span> : null}
                {tierName(tier)}
                <span className="visually-hidden">
                  {isUnlocked(tier) ? ' (unlocked)' : ' (locked)'}
                </span>
              </span>
              {tier.rarity ? (
                <span className={`rarity rarity--${tier.rarity}`}>
                  {RARITY_LABELS[tier.rarity]}
                </span>
              ) : null}
              <span className="tier__xp">+{tier.xpReward} XP</span>
            </li>
          ))}
        </ol>
        {latest?.unlockedAt ? (
          <UnlockedDate prefix={`${tierName(latest)} unlocked`} unlockedAt={latest.unlockedAt} />
        ) : null}
        {next && next.target !== undefined ? (
          <Progress achievement={next} label={series.name} suffix={` toward ${tierName(next)}`} />
        ) : null}
      </div>
    </li>
  );
};

export const AchievementsPanel = ({
  achievements,
  error = undefined,
  onClickClose,
}: AchievementsPanelProps) => {
  const unlockedCount = achievements.filter(isUnlocked).length;
  const groups = groupAchievements(achievements);
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
      {groups.map((group) => {
        const headingId = `achievements-${group.category}`;
        return (
          <section aria-labelledby={headingId} className="achievements__group" key={group.category}>
            <h3 className="achievements__heading" id={headingId}>
              {group.category === 'other' ? 'More' : CATEGORY_LABELS[group.category]}
            </h3>
            <ul className="achievements">
              {group.rows.map((row) =>
                row.kind === 'series' ? (
                  <SeriesRow key={row.series.id} series={row.series} tiers={row.tiers} />
                ) : (
                  <SingleRow achievement={row.achievement} key={row.achievement.id} />
                ),
              )}
            </ul>
          </section>
        );
      })}
    </Modal>
  );
};
