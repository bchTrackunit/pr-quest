import type { DifficultyTier } from '../shared/api.ts';

export interface TierBadgeProps {
  tier: DifficultyTier;
}

const TIER_META: Record<DifficultyTier, { icon: string; label: string; className: string }> = {
  Trivial: { icon: '🌱', label: 'Trivial', className: 'tier--trivial' },
  Normal: { icon: '⚔️', label: 'Normal', className: 'tier--normal' },
  Hard: { icon: '🔥', label: 'Hard', className: 'tier--hard' },
  Boss: { icon: '💀', label: 'Boss fight', className: 'tier--boss' },
};

export const TierBadge = ({ tier }: TierBadgeProps) => {
  const meta = TIER_META[tier];
  return (
    <span className={['tier', meta.className].join(' ')}>
      <span aria-hidden="true">{meta.icon}</span> <span className="pixel">{meta.label}</span>
    </span>
  );
};
