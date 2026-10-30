import { useEffect } from 'react';

import type { XpPopup } from './gameState.ts';

export interface XpPopupItemProps {
  popup: XpPopup;
  label: string;
  onDone: (popupId: string) => void;
}

const POPUP_MS = 2600;

export const XpPopupItem = ({ popup, label, onDone }: XpPopupItemProps) => {
  const { id } = popup;
  useEffect(() => {
    const timer = setTimeout(() => onDone(id), POPUP_MS);
    return () => clearTimeout(timer);
  }, [id, onDone]);

  return (
    <li className="xp-popup">
      <span className="xp-popup__amount pixel">+{popup.amount} XP</span>
      <span className="xp-popup__reason">{label}</span>
    </li>
  );
};
