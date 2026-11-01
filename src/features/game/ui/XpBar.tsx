import { formatNumber } from '../../../platform/ui/format.ts';

export interface XpBarProps {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
}

export const XpBar = ({ level, xpIntoLevel, xpForNextLevel }: XpBarProps) => {
  const max = Math.max(1, xpForNextLevel);
  const value = Math.min(Math.max(0, xpIntoLevel), max);
  const percent = Math.round((value / max) * 100);
  return (
    <div className="xp">
      <div className="xp__labels">
        <span className="pixel xp__caption">XP</span>
        <span className="xp__numbers">
          {formatNumber(value)} / {formatNumber(max)}
        </span>
      </div>
      <div
        aria-label={`Experience toward level ${level + 1}`}
        aria-valuemax={max}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuetext={`${formatNumber(value)} of ${formatNumber(max)} XP`}
        className="xp__track"
        role="progressbar"
      >
        <div className="xp__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};
