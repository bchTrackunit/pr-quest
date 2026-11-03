import type { ConnectionStatus } from './gameState.ts';

export interface ConnectionIndicatorProps {
  status: ConnectionStatus;
}

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
};

export const ConnectionIndicator = ({ status }: ConnectionIndicatorProps) => (
  <span
    className={['connection', `connection--${status}`].join(' ')}
    role="status"
    title={
      status === 'open' ? 'Live updates are on' : 'Live updates are paused; retrying with backoff'
    }
  >
    <span aria-hidden="true" className="connection__dot" />
    <span className="visually-hidden">Live updates: </span>
    {LABELS[status]}
  </span>
);
