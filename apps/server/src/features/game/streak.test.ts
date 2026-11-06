import { describe, expect, test } from 'vitest';

import {
  ACTIVE_DAYS_WINDOW,
  currentStreak,
  shiftDate,
  streakDaysFromCounter,
  withActiveDay,
  type StreakDays,
} from './streak.ts';

/** Local noon on a November 2026 day, so no time zone moves it across midnight. */
const noon = (dayOfMonth: number): Date => new Date(2026, 10, dayOfMonth, 12);
const NONE: StreakDays = { activeDays: [], streakCarry: 0 };

function daysEnding(last: string, count: number): Array<string> {
  return Array.from({ length: count }, (_, index) => shiftDate(last, index - count + 1));
}

describe('currentStreak', () => {
  test('counts back from today, or from yesterday until today ends', () => {
    const days = { activeDays: ['2026-11-08', '2026-11-09', '2026-11-10'], streakCarry: 0 };

    expect(currentStreak(days, noon(10))).toBe(3);
    expect(currentStreak(days, noon(11))).toBe(3);
    expect(currentStreak(days, noon(12))).toBe(0);
  });

  test('stops at a missed day', () => {
    const days = { activeDays: ['2026-11-07', '2026-11-09', '2026-11-10'], streakCarry: 4 };

    expect(currentStreak(days, noon(10))).toBe(2);
  });

  test('a run that reaches the oldest listed day continues into the carry', () => {
    const days = { activeDays: ['2026-11-09', '2026-11-10'], streakCarry: 70 };

    expect(currentStreak(days, noon(10))).toBe(72);
  });
});

describe('withActiveDay', () => {
  test('credits a past day inside the window, joining the streak up', () => {
    const before = { activeDays: ['2026-11-08', '2026-11-10'], streakCarry: 0 };

    const after = withActiveDay(before, '2026-11-09', '2026-11-10');

    expect(after.activeDays).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
    expect(currentStreak(after, noon(10))).toBe(3);
  });

  test('a day older than the window, or in the future, changes nothing', () => {
    const before = { activeDays: ['2026-11-10'], streakCarry: 0 };

    expect(
      withActiveDay(before, shiftDate('2026-11-10', -ACTIVE_DAYS_WINDOW), '2026-11-10'),
    ).toEqual(before);
    expect(withActiveDay(before, '2026-11-11', '2026-11-10')).toEqual(before);
  });

  test('days that leave the window move into the carry, so a long streak is never cut short', () => {
    let days = NONE;
    for (let offset = 0; offset < 100; offset++) {
      const date = shiftDate('2026-08-01', offset);
      days = withActiveDay(days, date, date);
    }
    const lastDay = shiftDate('2026-08-01', 99);

    expect(days.activeDays).toHaveLength(ACTIVE_DAYS_WINDOW);
    expect(days.streakCarry).toBe(40);
    const [year = 0, month = 1, dayOfMonth = 1] = lastDay.split('-').map(Number);
    expect(currentStreak(days, new Date(year, month - 1, dayOfMonth, 12))).toBe(100);
  });

  test('a gap at the edge of the window resets the carry', () => {
    const today = '2026-11-10';
    const start = shiftDate(today, -(ACTIVE_DAYS_WINDOW - 1));
    const days = { activeDays: [shiftDate(start, -1), shiftDate(start, 1), today], streakCarry: 9 };

    expect(withActiveDay(days, today, today)).toEqual({
      activeDays: [shiftDate(start, 1), today],
      streakCarry: 0,
    });
  });
});

describe('streakDaysFromCounter', () => {
  test('a short streak becomes its days, ending on the last review', () => {
    expect(streakDaysFromCounter(3, '2026-11-10')).toEqual({
      activeDays: ['2026-11-08', '2026-11-09', '2026-11-10'],
      streakCarry: 0,
    });
  });

  test('a streak longer than the window keeps the rest as carry, unchanged in length', () => {
    const days = streakDaysFromCounter(75, '2026-11-10');

    expect(days.activeDays).toEqual(daysEnding('2026-11-10', ACTIVE_DAYS_WINDOW));
    expect(days.streakCarry).toBe(15);
    expect(currentStreak(days, noon(10))).toBe(75);
  });

  test('no streak or no review date means no days', () => {
    expect(streakDaysFromCounter(0, '2026-11-10')).toEqual(NONE);
    expect(streakDaysFromCounter(4, undefined)).toEqual(NONE);
  });
});
