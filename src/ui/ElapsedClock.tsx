import { formatElapsed } from './format.ts';
import { useNow } from './useNow.ts';

export interface ElapsedClockProps {
  startedAt: string;
}

/** A ticking stopwatch. Not a live region: announcing every second would drown screen readers. */
export const ElapsedClock = ({ startedAt }: ElapsedClockProps) => {
  const now = useNow(1000);
  return (
    <time className="run__clock" dateTime={startedAt}>
      {formatElapsed(now - Date.parse(startedAt))}
    </time>
  );
};
