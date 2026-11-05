/** A moment as a wall clock in some time zone shows it. */
export interface ZonedTime {
  /** The calendar date, `YYYY-MM-DD`. */
  date: string;
  /** 0 to 23. */
  hour: number;
  /** 0 is Sunday, as with `Date#getDay`. */
  weekday: number;
}

const WEEKDAYS: ReadonlyArray<string> = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Without a zone, a fresh formatter on the local clock, which follows `TZ` if it changes. */
function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  if (timeZone === undefined) {
    return new Intl.DateTimeFormat('en-US', FORMAT);
  }
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...FORMAT, timeZone });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The IANA zone the machine's local `Date` methods use: `TZ` when set, else the system's. Undefined
 * when that names no zone, such as `TZ=` (which Node reports as `Etc/Unknown`) or a name it doesn't know.
 */
export function machineTimeZone(): string | undefined {
  // Node reports a `TZ` it can't resolve, such as `Not/A_Zone`, as undefined despite the types.
  const zone: unknown = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' ? canonicalTimeZone(zone) : undefined;
}

/**
 * `at` on a wall clock in `timeZone`, an IANA zone such as `Europe/Copenhagen`, or on the
 * machine's local clock when `timeZone` is undefined.
 */
export function zonedTime(at: Date, timeZone: string | undefined): ZonedTime {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${(parts.year ?? '').padStart(4, '0')}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** The calendar day before `date` (`YYYY-MM-DD`), whatever the clocks did that night. */
export function previousDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * `value` as the IANA zone name it stands for, or `undefined` when it isn't one. Fixed offsets, as
 * `+01:00` or `Etc/GMT-1`, are refused: they ignore daylight saving time, so a streak would end an
 * hour early, and the `Etc/GMT` signs are inverted. `Etc/Unknown` is Node's name for no zone.
 */
export function canonicalTimeZone(value: string): string | undefined {
  if (value === '' || value !== value.trim() || /^[+-]/.test(value)) {
    return undefined;
  }
  let zone: string;
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return /^Etc\/(GMT[+-]|Unknown$)/.test(zone) ? undefined : zone;
}
