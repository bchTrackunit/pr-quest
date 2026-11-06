/** How many local days `activeDays` keeps, ending today. */
export const ACTIVE_DAYS_WINDOW = 60;

/**
 * The days that keep the streak going. `activeDays` lists the active local dates (`YYYY-MM-DD`)
 * of the last `ACTIVE_DAYS_WINDOW` days in ascending order; `streakCarry` counts the consecutive
 * active days right before the oldest of them, so a long streak is never cut short.
 */
export interface StreakDays {
  activeDays: Array<string>;
  streakCarry: number;
}

export function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local date `days` after `date` (`YYYY-MM-DD`); negative goes back. */
export function shiftDate(date: string, days: number): string {
  const [year = 0, month = 1, dayOfMonth = 1] = date.split('-').map(Number);
  return localDate(new Date(year, month - 1, dayOfMonth + days));
}

/** The oldest local date `activeDays` may hold on `today`. */
function windowStart(today: string): string {
  return shiftDate(today, -(ACTIVE_DAYS_WINDOW - 1));
}

/**
 * Consecutive active days ending today, or yesterday so the streak can still be extended today.
 * A run that reaches the oldest listed day continues into `streakCarry`.
 */
export function currentStreak(days: StreakDays, now: Date): number {
  const active = new Set(days.activeDays);
  const today = localDate(now);
  let cursor = active.has(today) ? today : shiftDate(today, -1);
  let count = 0;
  while (active.has(cursor)) {
    count++;
    cursor = shiftDate(cursor, -1);
  }
  if (count > 0 && days.activeDays[0] === shiftDate(cursor, 1)) {
    count += days.streakCarry;
  }
  return count;
}

/**
 * Marks `date` active as of `today`. A date older than the window changes nothing; the oldest
 * days leave the list into `streakCarry` as the window moves on.
 */
export function withActiveDay(days: StreakDays, date: string, today: string): StreakDays {
  const start = windowStart(today);
  const active = new Set(days.activeDays);
  let carry = days.streakCarry;
  // Carried days inside the window are listed again, so a day added before them can't hide them.
  let oldest = days.activeDays[0];
  while (oldest !== undefined && carry > 0 && shiftDate(oldest, -1) >= start) {
    oldest = shiftDate(oldest, -1);
    active.add(oldest);
    carry--;
  }
  if (date >= start && date <= today) {
    active.add(date);
  }
  const sorted = [...active].sort();
  while (sorted.length > 0 && (sorted[0] ?? '') < start) {
    const dropped = sorted.shift() ?? '';
    const next = sorted[0];
    carry = next !== undefined && next === shiftDate(dropped, 1) ? carry + 1 : 0;
  }
  if (sorted.length === 0) {
    carry = 0;
  }
  return { activeDays: sorted, streakCarry: carry };
}

/** The version 2 counter as days: the last `streakDays` days up to `lastReviewDate`. */
export function streakDaysFromCounter(
  streakDays: number,
  lastReviewDate: string | undefined,
): StreakDays {
  if (!lastReviewDate || streakDays <= 0) {
    return { activeDays: [], streakCarry: 0 };
  }
  const listed = Math.min(streakDays, ACTIVE_DAYS_WINDOW);
  const activeDays = Array.from({ length: listed }, (_, index) =>
    shiftDate(lastReviewDate, index - listed + 1),
  );
  return { activeDays, streakCarry: streakDays - listed };
}
