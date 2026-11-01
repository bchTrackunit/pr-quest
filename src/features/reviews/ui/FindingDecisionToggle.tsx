import type { FindingDecision } from '../../../shared/api.ts';
import { Tooltip } from '../../../platform/ui/Tooltip.tsx';

export interface FindingDecisionToggleProps {
  /** `file:line` of the finding, which names the group for screen readers. */
  location: string;
  decision: FindingDecision;
  isDisabled: boolean;
  onChange: (decision: FindingDecision) => void;
}

const OPTIONS = [
  { decision: 'accepted', label: 'Accept', icon: '✓', tooltip: 'Accept: post this finding' },
  { decision: 'rejected', label: 'Reject', icon: '✕', tooltip: "Reject: don't post this finding" },
] as const satisfies ReadonlyArray<{
  decision: FindingDecision;
  label: string;
  icon: string;
  tooltip: string;
}>;

/** Accept and Reject for one finding. Pressing the active one again makes it undecided. */
export const FindingDecisionToggle = ({
  location,
  decision,
  isDisabled,
  onChange,
}: FindingDecisionToggleProps) => (
  <div aria-label={`Decision on ${location}`} className="decision-toggle" role="group">
    {OPTIONS.map((option) => {
      const isPressed = decision === option.decision;
      return (
        <Tooltip align="end" content={option.tooltip} key={option.decision}>
          {(describedBy) => (
            <button
              aria-describedby={describedBy}
              aria-label={option.label}
              aria-pressed={isPressed}
              className={[
                'decision-toggle__option',
                `decision-toggle__option--${option.decision}`,
              ].join(' ')}
              disabled={isDisabled}
              onClick={() => onChange(isPressed ? 'undecided' : option.decision)}
              type="button"
            >
              <span aria-hidden="true">{option.icon}</span>
            </button>
          )}
        </Tooltip>
      );
    })}
  </div>
);
