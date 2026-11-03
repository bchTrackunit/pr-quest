import { Tooltip } from '../../platform/Tooltip.tsx';

export interface FindingSelectToggleProps {
  /** `file:line` of the finding, which names the toggle for screen readers. */
  location: string;
  isSelected: boolean;
  isDisabled: boolean;
  onChange: (selected: boolean) => void;
}

/** Selects one finding to post; pressing it again leaves the finding out. */
export const FindingSelectToggle = ({
  location,
  isSelected,
  isDisabled,
  onChange,
}: FindingSelectToggleProps) => (
  <Tooltip
    align="end"
    content={isSelected ? 'Selected: this finding will be posted' : 'Select to post this finding'}
  >
    {(describedBy) => (
      <button
        aria-describedby={describedBy}
        aria-label={`Select ${location}`}
        aria-pressed={isSelected}
        className="finding-select"
        disabled={isDisabled}
        onClick={() => onChange(!isSelected)}
        type="button"
      >
        <span aria-hidden="true">✓</span>
      </button>
    )}
  </Tooltip>
);
