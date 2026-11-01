import { afterEach, describe, expect, test } from 'vitest';

import { canonicalTimeZone, machineTimeZone, previousDate, zonedTime } from './timeZone.ts';

describe('zonedTime', () => {
  test('reads the calendar date, hour and weekday in the given zone, not the machine one', () => {
    const at = new Date('2026-11-10T23:30:00Z');

    expect(zonedTime(at, 'UTC')).toEqual({ date: '2026-11-10', hour: 23, weekday: 2 });
    expect(zonedTime(at, 'Europe/Copenhagen')).toEqual({ date: '2026-11-11', hour: 0, weekday: 3 });
    expect(zonedTime(at, 'America/Los_Angeles')).toEqual({
      date: '2026-11-10',
      hour: 15,
      weekday: 2,
    });
  });

  test('uses hours 0 to 23, so midnight is hour 0', () => {
    expect(zonedTime(new Date('2026-11-10T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  test('follows the zone across a spring-forward change', () => {
    // Copenhagen skips 02:00-03:00 on 29 March 2026: 00:59Z is 01:59 CET, 01:00Z is 03:00 CEST.
    expect(zonedTime(new Date('2026-03-29T00:59:00Z'), 'Europe/Copenhagen').hour).toBe(1);
    expect(zonedTime(new Date('2026-03-29T01:00:00Z'), 'Europe/Copenhagen').hour).toBe(3);
  });

  test('follows the zone across a fall-back change', () => {
    // Copenhagen repeats 02:00-03:00 on 25 October 2026.
    expect(zonedTime(new Date('2026-10-25T00:30:00Z'), 'Europe/Copenhagen').hour).toBe(2);
    expect(zonedTime(new Date('2026-10-25T01:30:00Z'), 'Europe/Copenhagen').hour).toBe(2);
    expect(zonedTime(new Date('2026-10-25T22:59:00Z'), 'Europe/Copenhagen').date).toBe(
      '2026-10-25',
    );
    expect(zonedTime(new Date('2026-10-25T23:00:00Z'), 'Europe/Copenhagen').date).toBe(
      '2026-10-26',
    );
  });
});

describe('previousDate', () => {
  test.each([
    ['2026-11-10', '2026-11-09'],
    ['2026-03-01', '2026-02-28'],
    ['2028-03-01', '2028-02-29'],
    ['2027-01-01', '2026-12-31'],
    // The days of a clock change are still one calendar day apart.
    ['2026-03-30', '2026-03-29'],
    ['2026-10-26', '2026-10-25'],
  ])('the day before %s is %s', (date, expected) => {
    expect(previousDate(date)).toBe(expected);
  });
});

describe('canonicalTimeZone', () => {
  test.each([
    ['Europe/Copenhagen', 'Europe/Copenhagen'],
    ['europe/copenhagen', 'Europe/Copenhagen'],
    ['UTC', 'UTC'],
  ])('accepts the IANA zone %s as %s', (zone, expected) => {
    expect(canonicalTimeZone(zone)).toBe(expected);
  });

  test.each([
    'Mars/Olympus_Mons',
    '',
    '+01:00',
    '-05:00',
    'Etc/GMT+5',
    'Etc/GMT-14',
    'Etc/Unknown',
    'Europe/Copenhagen ',
  ])('refuses %j', (zone) => {
    expect(canonicalTimeZone(zone)).toBeUndefined();
  });
});

describe('machineTimeZone', () => {
  const original = process.env.TZ;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  });

  test("is the zone the machine's local Date methods use", () => {
    const at = new Date('2026-11-10T12:34:00Z');

    expect(zonedTime(at, machineTimeZone()).hour).toBe(at.getHours());
  });

  test.each(['', 'Not/A_Zone'])(
    'is undefined when TZ=%j names no zone, and zonedTime then follows the local clock',
    (tz) => {
      process.env.TZ = tz;
      const at = new Date('2026-11-10T23:34:00Z');

      expect(machineTimeZone()).toBeUndefined();
      expect(zonedTime(at, machineTimeZone())).toEqual({
        date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
        hour: at.getHours(),
        weekday: at.getDay(),
      });
    },
  );
});
