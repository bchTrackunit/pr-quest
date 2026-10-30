import { XP_REASON_LABELS, type XpPopup } from './gameState.ts';
import { XpPopupItem } from './XpPopupItem.tsx';

export interface XpPopupsProps {
  popups: Array<XpPopup>;
  onDone: (popupId: string) => void;
}

export const XpPopups = ({ popups, onDone }: XpPopupsProps) => (
  <ul aria-label="Experience gained" aria-live="polite" className="xp-popups">
    {popups.map((popup) => (
      <XpPopupItem
        key={popup.id}
        label={XP_REASON_LABELS[popup.reason]}
        onDone={onDone}
        popup={popup}
      />
    ))}
  </ul>
);
