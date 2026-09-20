import { isQuiet, recipientsFor, wantsDirection, type NotificationPrefs, type WatchRow } from "./notify.ts";
import { parseClockMinutes, withinDailyWindow } from "./timezone.ts";

const denoTest = (Deno as typeof Deno & {
  test(name: string, fn: () => void | Promise<void>): void;
}).test;

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const GUEST = "22222222-2222-2222-2222-222222222222";
const OWNER_LINE = "Uffffffffffffffffffffffffffffffff";
const noPrefs = new Map<string, NotificationPrefs>();
const owners = new Set([OWNER]);

/** 03:00 UTC is 10:00 in Bangkok: the middle of the SET morning session. */
const DAYTIME = Date.UTC(2026, 8, 20, 3, 0);
/** 18:00 UTC is 01:00 the next day in Bangkok. */
const MIDDLE_OF_THE_NIGHT = Date.UTC(2026, 8, 20, 18, 0);

denoTest("parseClockMinutes reads what Postgres returns for a time column", () => {
  assertEquals(parseClockMinutes("22:00:00"), 22 * 60);
  assertEquals(parseClockMinutes("07:30"), 7 * 60 + 30);
  assertEquals(parseClockMinutes("7:30"), 7 * 60 + 30);
  assertEquals(parseClockMinutes("22:00:00.000000"), 22 * 60);
  assertEquals(parseClockMinutes("24:00"), null);
  assertEquals(parseClockMinutes("22:60"), null);
  assertEquals(parseClockMinutes(null), null);
  assertEquals(parseClockMinutes("evening"), null);
});

denoTest("a quiet window that wraps past midnight covers both sides of it", () => {
  const night = [22 * 60, 7 * 60] as const;
  assertEquals(withinDailyWindow(night[0], night[1], 23 * 60), true);
  assertEquals(withinDailyWindow(night[0], night[1], 2 * 60), true);
  assertEquals(withinDailyWindow(night[0], night[1], 12 * 60), false);
  // Half-open: quiet at the start, audible again exactly at the end.
  assertEquals(withinDailyWindow(night[0], night[1], 22 * 60), true);
  assertEquals(withinDailyWindow(night[0], night[1], 7 * 60), false);
  // A window inside one day behaves the same way.
  assertEquals(withinDailyWindow(9 * 60, 17 * 60, 12 * 60), true);
  assertEquals(withinDailyWindow(9 * 60, 17 * 60, 8 * 60), false);
  // Equal endpoints describe no window rather than the whole day.
  assertEquals(withinDailyWindow(9 * 60, 9 * 60, 9 * 60), false);
});

denoTest("quiet hours are judged in the member's own timezone", () => {
  const prefs: NotificationPrefs = {
    user_id: GUEST,
    quiet_from: "22:00:00",
    quiet_to: "07:00:00",
    time_zone: "Asia/Bangkok",
  };
  assertEquals(isQuiet(prefs, MIDDLE_OF_THE_NIGHT), true);
  assertEquals(isQuiet(prefs, DAYTIME), false);
  // The same instant is not quiet for somebody in London, where it is 19:00.
  assertEquals(isQuiet({ ...prefs, time_zone: "Europe/London" }, MIDDLE_OF_THE_NIGHT), false);
});

denoTest("no window, a half-set window, or a broken zone never silences anybody", () => {
  assertEquals(isQuiet(undefined, MIDDLE_OF_THE_NIGHT), false);
  assertEquals(isQuiet({ user_id: GUEST }, MIDDLE_OF_THE_NIGHT), false);
  assertEquals(isQuiet({ user_id: GUEST, quiet_from: "22:00:00" }, MIDDLE_OF_THE_NIGHT), false);
  // An unusable zone falls back to Bangkok rather than throwing mid-fan-out.
  assertEquals(
    isQuiet({ user_id: GUEST, quiet_from: "22:00:00", quiet_to: "07:00:00", time_zone: "Not/AZone" }, MIDDLE_OF_THE_NIGHT),
    true,
  );
});

denoTest("direction is per instrument, and an unset list still means both", () => {
  assertEquals(wantsDirection({ user_id: GUEST, directions: ["bearish"] }, "bearish"), true);
  assertEquals(wantsDirection({ user_id: GUEST, directions: ["bearish"] }, "bullish"), false);
  assertEquals(wantsDirection({ user_id: GUEST, directions: ["bullish", "bearish"] }, "bullish"), true);
  // Rows written before the column existed, and rows somehow emptied.
  assertEquals(wantsDirection({ user_id: GUEST }, "bullish"), true);
  assertEquals(wantsDirection({ user_id: GUEST, directions: [] }, "bearish"), true);
});

denoTest("a muted instrument is scanned and charted but nobody is told", () => {
  const rows: WatchRow[] = [{ user_id: GUEST, notify: false, directions: ["bullish", "bearish"] }];
  assertEquals(recipientsFor(rows, noPrefs, "bullish", DAYTIME, OWNER_LINE, owners), []);
});

denoTest("one alert reaches the people who want it and skips the people who do not", () => {
  const rows: WatchRow[] = [
    { user_id: OWNER, notify: true, directions: ["bullish", "bearish"], channels: ["push", "line"] },
    { user_id: GUEST, notify: true, directions: ["bearish"], channels: ["push"] },
  ];
  const bullish = recipientsFor(rows, noPrefs, "bullish", DAYTIME, OWNER_LINE, owners);
  assertEquals(bullish.map((r) => r.userId), [OWNER]);
  assertEquals([...bullish[0].channels].sort(), ["line", "push"]);
  // The owner's LINE destination is the function's secret; the guest has none on file.
  assertEquals(bullish[0].lineUserId, OWNER_LINE);

  const bearish = recipientsFor(rows, noPrefs, "bearish", DAYTIME, OWNER_LINE, owners);
  assertEquals(bearish.map((r) => r.userId).sort(), [OWNER, GUEST].sort());
  const guest = bearish.find((r) => r.userId === GUEST);
  assertEquals([...(guest?.channels ?? [])], ["push"]);
  assertEquals(guest?.lineUserId, null);
});

denoTest("quiet hours drop a member from one alert without affecting anyone else", () => {
  const rows: WatchRow[] = [
    { user_id: OWNER, notify: true, channels: ["push"] },
    { user_id: GUEST, notify: true, channels: ["push"] },
  ];
  const prefs = new Map<string, NotificationPrefs>([
    [GUEST, { user_id: GUEST, quiet_from: "22:00:00", quiet_to: "07:00:00", time_zone: "Asia/Bangkok" }],
  ]);
  assertEquals(
    recipientsFor(rows, prefs, "bullish", MIDDLE_OF_THE_NIGHT, OWNER_LINE, owners).map((r) => r.userId),
    [OWNER],
  );
  assertEquals(
    recipientsFor(rows, prefs, "bullish", DAYTIME, OWNER_LINE, owners).map((r) => r.userId).sort(),
    [OWNER, GUEST].sort(),
  );
});

denoTest("a member with a LINE destination of their own gets their own messages", () => {
  const guestLine = "U00000000000000000000000000000001";
  const rows: WatchRow[] = [{ user_id: GUEST, notify: true, channels: ["line"] }];
  const prefs = new Map<string, NotificationPrefs>([[GUEST, { user_id: GUEST, line_user_id: guestLine }]]);
  const recipients = recipientsFor(rows, prefs, "bullish", DAYTIME, OWNER_LINE, owners);
  assertEquals(recipients[0].lineUserId, guestLine);
  assertEquals([...recipients[0].channels], ["line"]);
});

denoTest("a row with no channels still gets a push rather than silently nothing", () => {
  const rows: WatchRow[] = [{ user_id: GUEST, notify: true, channels: [] }];
  const recipients = recipientsFor(rows, noPrefs, "bullish", DAYTIME, OWNER_LINE, owners);
  assertEquals([...recipients[0].channels], ["push"]);
});
