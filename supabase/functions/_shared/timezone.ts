// Wall-clock arithmetic in a named IANA zone.
//
// Two things in this project need it and neither can use UTC: an exchange's session close is
// written in the exchange's own local time, and a member's quiet hours are written in theirs.
// `Intl.DateTimeFormat` is the only timezone database available in the edge runtime, so the
// conversions are built from it rather than from a dependency.

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at a given instant. */
export function zoneParts(utcMs: number, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** How far the zone is ahead of UTC at a given instant. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zoneParts(utcMs, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

/** The UTC instant of a wall-clock time in a zone. The second pass settles DST transitions. */
export function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  return asIfUtc - zoneOffsetMs(firstPass, timeZone);
}

/** Minutes past local midnight in `timeZone`, for comparing against a stored time-of-day. */
export function minutesOfDay(utcMs: number, timeZone: string): number {
  const parts = zoneParts(utcMs, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** "22:00" / "22:00:00" as minutes past midnight, or null when it is not a time at all. */
export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Whether `nowMinutes` falls inside a daily window that may wrap past midnight.
 *
 * A window is half-open — it includes its start and excludes its end — so 22:00-07:00 is quiet
 * at 22:00 and audible again exactly at 07:00. Equal endpoints describe no window rather than a
 * whole day: a member who wants silence around the clock mutes the instruments instead.
 */
export function withinDailyWindow(fromMinutes: number, toMinutes: number, nowMinutes: number): boolean {
  if (fromMinutes === toMinutes) return false;
  return fromMinutes < toMinutes
    ? nowMinutes >= fromMinutes && nowMinutes < toMinutes
    : nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}
