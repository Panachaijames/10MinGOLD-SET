// Who gets told about an alert, and on what.
//
// Detection and delivery are deliberately separate. One scan of an instrument serves everybody
// watching it, so the scanner cannot apply anyone's preferences without applying them to
// everyone; the alert row is the neutral fact, and these rules decide what each member is sent.
// A muted instrument, a direction somebody does not trade, and a quiet hour all suppress the
// notification while leaving the alert in the history and on the charts.
import { minutesOfDay, parseClockMinutes, withinDailyWindow } from "./timezone.ts";

export type Channel = "push" | "line";

/** One member's row for the instrument an alert belongs to. */
export interface WatchRow {
  user_id: string;
  notify?: boolean | null;
  directions?: string[] | null;
  channels?: string[] | null;
}

/** One member's delivery preferences; absent rows simply mean "no preferences set". */
export interface NotificationPrefs {
  user_id: string;
  quiet_from?: string | null;
  quiet_to?: string | null;
  time_zone?: string | null;
  line_user_id?: string | null;
}

export interface Recipient {
  userId: string;
  channels: Set<Channel>;
  /** Where this member's LINE messages go, when they have a destination at all. */
  lineUserId: string | null;
}

const DEFAULT_ZONE = "Asia/Bangkok";

function asChannels(value: unknown): Set<Channel> {
  const list = Array.isArray(value) ? value : [];
  const channels = new Set<Channel>();
  for (const entry of list) {
    if (entry === "push" || entry === "line") channels.add(entry);
  }
  // An older row written before channels existed, or one somehow emptied: push is the channel
  // every enrolled device already has, so it is the safe reading of "notify me".
  return channels.size ? channels : new Set<Channel>(["push"]);
}

/**
 * Whether a member is inside their own quiet window right now.
 *
 * The window is stored in their local zone because that is how people think about sleep, and an
 * unknown or malformed zone must not silence somebody by accident — it falls back to Bangkok
 * rather than throwing or treating the window as always-on.
 */
export function isQuiet(prefs: NotificationPrefs | undefined, nowMs: number): boolean {
  if (!prefs) return false;
  const from = parseClockMinutes(prefs.quiet_from);
  const to = parseClockMinutes(prefs.quiet_to);
  if (from === null || to === null) return false;
  let localNow: number;
  try {
    localNow = minutesOfDay(nowMs, prefs.time_zone || DEFAULT_ZONE);
  } catch {
    localNow = minutesOfDay(nowMs, DEFAULT_ZONE);
  }
  return withinDailyWindow(from, to, localNow);
}

/** Whether this member asked to hear about this direction on this instrument. */
export function wantsDirection(row: WatchRow, direction: string): boolean {
  const directions = Array.isArray(row.directions) ? row.directions : null;
  // No stored preference is "both", which is what every row had before directions existed.
  if (!directions || !directions.length) return direction === "bullish" || direction === "bearish";
  return directions.includes(direction);
}

/**
 * The members to notify about one alert, each with the channels they chose.
 *
 * Returns an empty list when nobody wants it — which is a normal outcome, not a failure: the
 * alert is still recorded, charted and visible in the history for everyone watching.
 */
export function recipientsFor(
  rows: WatchRow[],
  prefsByUser: Map<string, NotificationPrefs>,
  direction: string,
  nowMs: number,
  ownerLineUserId: string | null,
  ownerIds: Set<string>,
): Recipient[] {
  const byUser = new Map<string, Recipient>();
  for (const row of rows) {
    if (row.notify === false) continue;
    if (!wantsDirection(row, direction)) continue;
    const prefs = prefsByUser.get(row.user_id);
    if (isQuiet(prefs, nowMs)) continue;

    const existing = byUser.get(row.user_id);
    const channels = asChannels(row.channels);
    if (existing) {
      // The same member can hold more than one row for an instrument only across timeframes, but
      // merging is still the right reading: any row asking for a channel is a yes for it.
      for (const channel of channels) existing.channels.add(channel);
      continue;
    }
    byUser.set(row.user_id, {
      userId: row.user_id,
      channels,
      // The owner's LINE destination is the function's own secret; a member has one only if it
      // has been recorded for them.
      lineUserId: prefs?.line_user_id ?? (ownerIds.has(row.user_id) ? ownerLineUserId : null),
    });
  }
  return [...byUser.values()];
}
