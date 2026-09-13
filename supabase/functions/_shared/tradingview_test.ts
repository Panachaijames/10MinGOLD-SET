import { closedOnly, resample, type Bar } from "./tradingview.ts";

const denoTest = (Deno as typeof Deno & {
  test(name: string, fn: () => void | Promise<void>): void;
}).test;

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number | null,
): Bar {
  return { time, open, high, low, close, volume };
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

denoTest("resample keeps only complete, epoch-aligned M10 buckets", () => {
  const start = 1_800_000_000; // divisible by ten minutes
  const actual = resample([
    // Deliberately out of order: OHLC must follow candle time, not response order.
    candle(start + 300, 101, 105, 99, 104, 7),
    candle(start - 300, 90, 94, 89, 93, 3), // only the second half of its bucket
    candle(start + 600, 104, 106, 103, 105, 8), // only the first half of its bucket
    candle(start, 100, 103, 98, 101, 5),
  ], 10, 5);

  assertEquals(actual, [candle(start, 100, 105, 98, 104, 12)]);
});

denoTest("resample rejects duplicate and misaligned source slots", () => {
  const start = 1_800_000_000;
  assertEquals(
    resample([
      candle(start, 100, 101, 99, 100, 1),
      candle(start, 100, 102, 98, 101, 2),
    ], 10, 5),
    [],
  );
  assertEquals(
    resample([
      candle(start, 100, 101, 99, 100, 1),
      candle(start + 301, 100, 102, 98, 101, 2),
    ], 10, 5),
    [],
  );
});

denoTest("resample preserves unknown volume and closedOnly includes the exact close boundary", () => {
  const start = 1_800_000_000;
  const bars = resample([
    candle(start, 100, 101, 99, 100, null),
    candle(start + 300, 100, 102, 98, 101, 2),
  ], 10, 5);

  assertEquals(bars[0].volume, null);
  assertEquals(closedOnly(bars, 10, (start + 600) * 1000 - 1), []);
  assertEquals(closedOnly(bars, 10, (start + 600) * 1000), bars);
});
