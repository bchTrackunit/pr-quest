const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age such as `just now`, `12m`, `5h` or `3d`. */
export function formatAge(fromIso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(fromIso));
  if (Number.isNaN(elapsed) || elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }
  return `${Math.floor(elapsed / DAY)}d`;
}

/** Relative time for a sentence: `just now` or `12m ago`. */
export function formatAgo(fromIso: string, now: number): string {
  const age = formatAge(fromIso, now);
  return age === 'just now' ? age : `${age} ago`;
}

/** Stopwatch format, `mm:ss` or `h:mm:ss`. */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}
