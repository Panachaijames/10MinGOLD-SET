import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { AlertRecord, Candle, SetMacdPoint } from "./api";

// Lightweight Charts renders timestamps in UTC. Shifting every timestamp by Bangkok's fixed
// offset (UTC+7, no DST) makes the axis and crosshair read as local wall-clock time.
const BANGKOK_OFFSET_S = 7 * 3600;
const toChartTime = (iso: string): UTCTimestamp => (Math.floor(Date.parse(iso) / 1000) + BANGKOK_OFFSET_S) as UTCTimestamp;

/**
 * Wilder's RSI, the same recursion as TradingView's ta.rsi: seed the average gain and loss
 * with a simple mean over the first `length` changes, then smooth each later bar by
 * (prev * (length - 1) + current) / length. Values before the seed are null, not zero.
 *
 * Computed here in the browser from the closes the chart already holds, so adding an
 * indicator costs no database column, no watcher change, and no extra API call.
 */
export function wilderRsi(closes: number[], length = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= length) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= length;
  loss /= length;
  const rsiAt = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[length] = rsiAt();
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (length - 1) + Math.max(0, change)) / length;
    loss = (loss * (length - 1) + Math.max(0, -change)) / length;
    out[i] = rsiAt();
  }
  return out;
}

// ---------------------------------------------------------------- indicator maths
// Everything here runs in the browser over the candles the chart already holds, so adding an
// indicator costs no database column, no watcher change and no extra request.

/** Exponential moving average, alpha = 2/(n+1), seeded with the simple mean of the first n. */
export function ema(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < length || length < 1) return out;
  const alpha = 2 / (length + 1);
  let current = values.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  out[length - 1] = current;
  for (let i = length; i < values.length; i++) {
    current = values[i] * alpha + current * (1 - alpha);
    out[i] = current;
  }
  return out;
}

/** Simple moving average. */
export function sma(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length < 1) return out;
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i];
    if (i >= length) running -= values[i - length];
    if (i >= length - 1) out[i] = running / length;
  }
  return out;
}

/** Bollinger bands on a POPULATION standard deviation, which is what charting packages use. */
export function bollinger(values: number[], length = 20, multiplier = 2) {
  const middle = sma(values, length);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    const mean = middle[i];
    if (mean == null) continue;
    const window = values.slice(i - length + 1, i + 1);
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / length;
    const deviation = Math.sqrt(variance) * multiplier;
    upper[i] = mean + deviation;
    lower[i] = mean - deviation;
  }
  return { upper, middle, lower };
}

/** Stochastic oscillator: %K over `length`, smoothed, with %D the moving average of %K. */
export function stochastic(highs: number[], lows: number[], closes: number[], length = 14, smoothK = 3, smoothD = 3) {
  const rawK: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = length - 1; i < closes.length; i++) {
    const highest = Math.max(...highs.slice(i - length + 1, i + 1));
    const lowest = Math.min(...lows.slice(i - length + 1, i + 1));
    const span = highest - lowest;
    rawK[i] = span === 0 ? 100 : ((closes[i] - lowest) / span) * 100;
  }
  const smooth = (input: (number | null)[], window: number): (number | null)[] => {
    const out: (number | null)[] = new Array(input.length).fill(null);
    for (let i = 0; i < input.length; i++) {
      const slice = input.slice(Math.max(0, i - window + 1), i + 1);
      if (slice.length < window || slice.some((value) => value == null)) continue;
      out[i] = (slice as number[]).reduce((sum, value) => sum + value, 0) / window;
    }
    return out;
  };
  const k = smooth(rawK, smoothK);
  return { k, d: smooth(k, smoothD) };
}

/** Average true range with Wilder smoothing, the same recursion RSI uses. */
export function atr(highs: number[], lows: number[], closes: number[], length = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= length) return out;
  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trueRanges.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let current = trueRanges.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  out[length] = current;
  for (let i = length; i < trueRanges.length; i++) {
    current = (current * (length - 1) + trueRanges[i]) / length;
    out[i + 1] = current;
  }
  return out;
}

export type IndicatorKey = "ema20" | "ema50" | "bollinger" | "macd" | "rsi" | "stoch" | "atr";

/** `overlay` indicators draw on the price pane; the rest each get a pane of their own. */
export const INDICATORS: { key: IndicatorKey; label: string; overlay: boolean }[] = [
  { key: "ema20", label: "EMA 20", overlay: true },
  { key: "ema50", label: "EMA 50", overlay: true },
  { key: "bollinger", label: "Bollinger 20/2", overlay: true },
  { key: "macd", label: "MACD 12/26/9", overlay: false },
  { key: "rsi", label: "RSI 14", overlay: false },
  { key: "stoch", label: "Stochastic 14/3/3", overlay: false },
  { key: "atr", label: "ATR 14", overlay: false }
];

export const DEFAULT_INDICATORS: IndicatorKey[] = ["macd", "rsi"];

/** Keep the configured order and drop anything unknown, so a stale saved list cannot break a chart. */
export function orderIndicators(keys: string[]): IndicatorKey[] {
  return INDICATORS.filter((indicator) => keys.includes(indicator.key)).map((indicator) => indicator.key);
}

const RSI_LENGTH = 14;

/** How old the newest candle is, in words. "CLOSED" alone reads as "the market is shut". */
export function ageLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return "just now";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const COLORS = {
  up: "#71e1c1",
  down: "#ff8f7b",
  macd: "#2962ff",
  signal: "#ff6d00",
  rsi: "#b388ff",
  band: "rgba(179, 136, 255, 0.35)",
  ema20: "#ffd166",
  ema50: "#4dd0e1",
  bollinger: "rgba(142, 163, 157, 0.75)",
  stochK: "#f06292",
  stochD: "#9575cd",
  atr: "#80cbc4",
  text: "#8ea39d",
  grid: "rgba(142, 163, 157, 0.08)",
  crosshair: "rgba(41, 98, 255, 0.5)"
};

function baseOptions(height: number) {
  return {
    height,
    autoSize: false,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: COLORS.text,
      fontFamily: '"DM Mono", ui-monospace, monospace',
      fontSize: 11,
      panes: { separatorColor: "rgba(142,163,157,0.25)", separatorHoverColor: "rgba(214,173,92,0.35)", enableResize: false }
    },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: COLORS.crosshair, labelBackgroundColor: "#0b2a27" }, horzLine: { color: COLORS.crosshair, labelBackgroundColor: "#0b2a27" } },
    rightPriceScale: { borderColor: "rgba(142,163,157,0.2)" },
    timeScale: { borderColor: "rgba(142,163,157,0.2)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
  } as const;
}

/** Keeps the chart width in step with its container (autoSize needs ResizeObserver support everywhere). */
function useResize(container: RefObject<HTMLDivElement>, chart: MutableRefObject<IChartApi | null>) {
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // Height as well as width: in the chart grid and in fullscreen the cell decides the size,
    // and a chart left at its creation height would overflow or leave a gap.
    const apply = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) chart.current?.applyOptions({ width, height });
      else if (width > 0) chart.current?.applyOptions({ width });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, chart]);
}

interface CandleChartProps {
  candles: Candle[];
  alerts: AlertRecord[];
  symbol: string;
  timeframe: number;
  forming?: Candle | null;
  /** How to describe the newest price when there is no forming candle. */
  priceStatus?: "closed" | "delayed";
  height?: number;
  /** Which indicators to draw; overlays share the price pane, the rest each get their own. */
  indicators?: IndicatorKey[];
}

/**
 * Candlesticks with whichever indicators the user has switched on. Overlays draw on the price
 * pane; every other indicator gets a pane of its own, in the order INDICATORS lists them.
 */
export function CandleChart({ candles, alerts, symbol, timeframe, forming, priceStatus = "closed", height = 560, indicators = DEFAULT_INDICATORS }: CandleChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const enabled = useMemo(() => orderIndicators(indicators), [indicators]);
  const enabledKey = enabled.join(",");
  // Changing the indicator set has to rebuild the chart, which throws away every series. The
  // epoch makes the data effect run again afterwards, so the new series are filled rather than
  // left empty the way a layout change used to leave them.
  const [epoch, setEpoch] = useState(0);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    markers: ISeriesMarkersPluginApi<Time>;
    hist: ISeriesApi<"Histogram"> | null;
    lines: Partial<Record<string, ISeriesApi<"Line">>>;
  } | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const api = createChart(container.current, baseOptions(height));
    const candleSeries = api.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      priceLineVisible: true,
      lastValueVisible: true
    });
    const lines: Partial<Record<string, ISeriesApi<"Line">>> = {};
    let hist: ISeriesApi<"Histogram"> | null = null;
    const fine = { type: "price" as const, precision: 4, minMove: 0.0001 };
    const percent = { type: "price" as const, precision: 1, minMove: 0.1 };
    const bounded = () => ({ priceRange: { minValue: 0, maxValue: 100 } });

    if (enabled.includes("ema20")) {
      lines.ema20 = api.addSeries(LineSeries, { color: COLORS.ema20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    }
    if (enabled.includes("ema50")) {
      lines.ema50 = api.addSeries(LineSeries, { color: COLORS.ema50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    }
    if (enabled.includes("bollinger")) {
      for (const key of ["bbUpper", "bbMiddle", "bbLower"]) {
        lines[key] = api.addSeries(LineSeries, {
          color: COLORS.bollinger,
          lineWidth: 1,
          lineStyle: key === "bbMiddle" ? 0 : 2,
          priceLineVisible: false,
          lastValueVisible: false
        }, 0);
      }
    }

    let pane = 1;
    for (const key of enabled) {
      if (INDICATORS.find((indicator) => indicator.key === key)?.overlay) continue;
      if (key === "macd") {
        hist = api.addSeries(HistogramSeries, { priceFormat: fine, priceLineVisible: false, lastValueVisible: false }, pane);
        lines.macd = api.addSeries(LineSeries, { color: COLORS.macd, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fine }, pane);
        lines.signal = api.addSeries(LineSeries, { color: COLORS.signal, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fine }, pane);
      } else if (key === "rsi") {
        // Pinned to 0-100 so the 30/70 guides sit where the eye expects them rather than
        // drifting with whatever range the visible bars happen to cover.
        const rsiSeries = api.addSeries(LineSeries, { color: COLORS.rsi, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: percent, autoscaleInfoProvider: bounded }, pane);
        for (const level of [70, 30]) {
          rsiSeries.createPriceLine({ price: level, color: COLORS.band, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
        }
        lines.rsi = rsiSeries;
      } else if (key === "stoch") {
        const stochKSeries = api.addSeries(LineSeries, { color: COLORS.stochK, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: percent, autoscaleInfoProvider: bounded }, pane);
        for (const level of [80, 20]) {
          stochKSeries.createPriceLine({ price: level, color: COLORS.band, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
        }
        lines.stochK = stochKSeries;
        lines.stochD = api.addSeries(LineSeries, { color: COLORS.stochD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: percent, autoscaleInfoProvider: bounded }, pane);
      } else if (key === "atr") {
        lines.atr = api.addSeries(LineSeries, { color: COLORS.atr, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fine }, pane);
      }
      pane++;
    }

    const panes = api.panes();
    panes[0]?.setStretchFactor(2.6);
    for (let index = 1; index < panes.length; index++) panes[index]?.setStretchFactor(1);
    const markers = createSeriesMarkers(candleSeries, []);
    chart.current = api;
    series.current = { candles: candleSeries, markers, hist, lines };
    setEpoch((value) => value + 1);
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
    };
    // Deliberately NOT keyed on height: a layout change only resizes the cell, and tearing the
    // chart down would drop every series along with the user's zoom and scroll position.
  }, [enabledKey]);

  useResize(container, chart);
  useEffect(() => { chart.current?.applyOptions({ height }); }, [height]);
  const newestTime = useRef<string | null>(null);

  const values = useMemo(() => {
    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    return {
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      bands: bollinger(closes, 20, 2),
      rsi: wilderRsi(closes, RSI_LENGTH),
      stoch: stochastic(highs, lows, closes, 14, 3, 3),
      atr: atr(highs, lows, closes, 14)
    };
  }, [candles]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    const candleData = candles.map((c) => ({
      time: toChartTime(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));

    if (forming) {
      const fTime = toChartTime(forming.time);
      const lastIdx = candleData.length - 1;
      const bar = { time: fTime, open: forming.open, high: forming.high, low: forming.low, close: forming.close };
      if (lastIdx >= 0 && candleData[lastIdx].time === fTime) {
        candleData[lastIdx] = bar;
      } else if (lastIdx < 0 || (candleData[lastIdx].time as number) < (fTime as number)) {
        candleData.push(bar);
      }
    }
    current.candles.setData(candleData);

    /** Points for one indicator, dropping the leading bars where it has not warmed up yet. */
    const lineData = (source: (number | null)[]) =>
      candles
        .map((candle, index) => ({ time: toChartTime(candle.time), value: source[index] }))
        .filter((point): point is { time: UTCTimestamp; value: number } => point.value != null);

    current.hist?.setData(
      candles
        .filter((c) => c.histogram != null)
        .map((c) => ({ time: toChartTime(c.time), value: c.histogram as number, color: (c.histogram as number) >= 0 ? "rgba(113,225,193,0.55)" : "rgba(255,143,123,0.55)" }))
    );
    current.lines.macd?.setData(candles.filter((c) => c.macd != null).map((c) => ({ time: toChartTime(c.time), value: c.macd as number })));
    current.lines.signal?.setData(candles.filter((c) => c.signal != null).map((c) => ({ time: toChartTime(c.time), value: c.signal as number })));
    current.lines.ema20?.setData(lineData(values.ema20));
    current.lines.ema50?.setData(lineData(values.ema50));
    current.lines.bbUpper?.setData(lineData(values.bands.upper));
    current.lines.bbMiddle?.setData(lineData(values.bands.middle));
    current.lines.bbLower?.setData(lineData(values.bands.lower));
    current.lines.rsi?.setData(lineData(values.rsi));
    current.lines.stochK?.setData(lineData(values.stoch.k));
    current.lines.stochD?.setData(lineData(values.stoch.d));
    current.lines.atr?.setData(lineData(values.atr));

    const candleTimes = new Set(candles.map((c) => c.time));
    const markers: SeriesMarker<Time>[] = alerts
      .filter((a) => a.symbol === symbol && a.timeframe_minutes === timeframe && a.direction !== "info" && candleTimes.has(a.bar_open))
      .map((a): SeriesMarker<Time> => ({
        time: toChartTime(a.bar_open),
        position: a.direction === "bullish" ? "belowBar" : "aboveBar",
        shape: a.direction === "bullish" ? "arrowUp" : "arrowDown",
        color: a.direction === "bullish" ? COLORS.up : COLORS.down,
        text: a.direction === "bullish" ? "MACD ▲" : "MACD ▼"
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    current.markers.setMarkers(markers);

    // Follow the newest bar only on first load or when a new bar arrived while the user was
    // already at the right edge; never yank the view away from a bar they scrolled back to.
    const newest = candles.length ? candles[candles.length - 1].time : null;
    const firstLoad = newestTime.current === null;
    const advanced = newest !== newestTime.current;
    newestTime.current = newest;
    const timeScale = chart.current?.timeScale();
    if (timeScale && (firstLoad || (advanced && timeScale.scrollPosition() >= 0))) timeScale.scrollToRealTime();
  }, [candles, alerts, symbol, timeframe, values, epoch]);

  // Live in-place update for forming candle ticks
  useEffect(() => {
    const current = series.current;
    if (!current || !forming) return;
    try {
      current.candles.update({
        time: toChartTime(forming.time),
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close
      });
    } catch {
      // Ignore transient timestamp order races
    }
  }, [forming]);

  const last = candles.length ? candles[candles.length - 1] : null;
  const lastIndex = candles.length - 1;
  const livePrice = forming ? forming.close : last?.close;
  const live = Boolean(forming);
  // The badge describes the DATA, not the market: Bitcoin never closes, but we still only hold
  // its closed candles, so "CLOSED" on its own was reading as "this market is shut".
  const priceLabel = live ? "LIVE" : priceStatus === "delayed" ? "DELAYED CLOSE" : "LAST CLOSE";
  const newestCloseMs = last ? Date.parse(last.time) + timeframe * 60_000 : null;
  const freshness = live || newestCloseMs === null ? null : ageLabel(Date.now() - newestCloseMs);
  const lastRsi = lastIndex >= 0 ? values.rsi[lastIndex] : null;
  const rsiTone = lastRsi == null ? COLORS.rsi : lastRsi >= 70 ? COLORS.down : lastRsi <= 30 ? COLORS.up : COLORS.rsi;
  const reading = (source: (number | null)[], digits: number) => {
    const value = lastIndex >= 0 ? source[lastIndex] : null;
    return value == null ? "—" : value.toFixed(digits);
  };

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        {livePrice != null && (
          <span className={`price-badge ${live ? "live" : priceStatus}`}>
            {live && <span className="live-dot" />} {priceLabel} {livePrice.toFixed(2)}
            {freshness && <span className="badge-age"> · {freshness}</span>}
          </span>
        )}
        {enabled.includes("ema20") && <span><i style={{ background: COLORS.ema20 }} /> EMA20 {reading(values.ema20, 2)}</span>}
        {enabled.includes("ema50") && <span><i style={{ background: COLORS.ema50 }} /> EMA50 {reading(values.ema50, 2)}</span>}
        {enabled.includes("bollinger") && (
          <span><i style={{ background: COLORS.bollinger }} /> BB {reading(values.bands.lower, 2)} / {reading(values.bands.upper, 2)}</span>
        )}
        {enabled.includes("macd") && (
          <>
            <span><i style={{ background: COLORS.macd }} /> MACD {last?.macd?.toFixed(4) ?? "—"}</span>
            <span><i style={{ background: COLORS.signal }} /> Signal {last?.signal?.toFixed(4) ?? "—"}</span>
            <span><i style={{ background: (last?.histogram ?? 0) >= 0 ? COLORS.up : COLORS.down }} /> Hist {last?.histogram?.toFixed(4) ?? "—"}</span>
          </>
        )}
        {enabled.includes("rsi") && (
          <span><i style={{ background: rsiTone }} /> RSI(14) {lastRsi?.toFixed(1) ?? "—"}{lastRsi == null ? "" : lastRsi >= 70 ? " overbought" : lastRsi <= 30 ? " oversold" : ""}</span>
        )}
        {enabled.includes("stoch") && (
          <span><i style={{ background: COLORS.stochK }} /> Stoch {reading(values.stoch.k, 1)} / {reading(values.stoch.d, 1)}</span>
        )}
        {enabled.includes("atr") && <span><i style={{ background: COLORS.atr }} /> ATR(14) {reading(values.atr, 2)}</span>}
        <span className="chart-legend-note">{candles.length} closed candles · times in Bangkok{last?.provisional ? " · last candle closed by clock" : ""}</span>
      </div>
      <div ref={container} className="chart-surface" />
    </div>
  );
}

interface MacdChartProps {
  points: SetMacdPoint[];
  height?: number;
}

/**
 * Chart for SET tickers. The scanner gives no OHLC, so there are no candlesticks, but it does
 * store the close of every bar it reads: that becomes a price line above the MACD pane, with
 * RSI below once enough bars have accumulated.
 */
export function MacdChart({ points, height = 260 }: MacdChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    price: ISeriesApi<"Line">;
    hist: ISeriesApi<"Histogram">;
    macd: ISeriesApi<"Line">;
    signal: ISeriesApi<"Line">;
    rsi: ISeriesApi<"Line"> | null;
  } | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const api = createChart(container.current, baseOptions(height));
    const price = api.addSeries(LineSeries, {
      color: COLORS.up,
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 }
    }, 0);
    const hist = api.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: false }, 1);
    const macd = api.addSeries(LineSeries, { color: COLORS.macd, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, 1);
    const signal = api.addSeries(LineSeries, { color: COLORS.signal, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, 1);
    api.panes()[0]?.setStretchFactor(2);
    api.panes()[1]?.setStretchFactor(1);
    chart.current = api;
    // The RSI pane is added only once enough closes exist: the scanner stores one point per
    // closed bar, so a freshly enabled ticker has none and an empty pane would just look broken.
    series.current = { price, hist, macd, signal, rsi: null };
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
    };
    // Deliberately NOT keyed on height: a layout change only resizes the cell, and tearing the
    // chart down would drop every series (and the user's zoom) while the data effects below,
    // whose inputs did not change, would never refill them.
  }, []);

  useResize(container, chart);
  useEffect(() => { chart.current?.applyOptions({ height }); }, [height]);
  const newestTime = useRef<string | null>(null);

  const sorted = useMemo(() => [...points].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), [points]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    current.price.setData(
      sorted
        .map((p) => ({ time: toChartTime(p.time), value: p.close }))
        .filter((point): point is { time: UTCTimestamp; value: number } => point.value != null)
    );
    current.hist.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.histogram, color: p.histogram >= 0 ? "rgba(113,225,193,0.55)" : "rgba(255,143,123,0.55)" })));
    current.macd.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.macd })));
    current.signal.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.signal })));

    const closes = sorted.map((p) => p.close);
    const api = chart.current;
    if (api && closes.every((c): c is number => c != null) && closes.length > RSI_LENGTH) {
      if (!current.rsi) {
        current.rsi = api.addSeries(LineSeries, {
          color: COLORS.rsi,
          lineWidth: 2,
          priceLineVisible: false,
          priceFormat: { type: "price", precision: 1, minMove: 0.1 },
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
        }, 2);
        for (const level of [70, 30]) {
          current.rsi.createPriceLine({ price: level, color: COLORS.band, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
        }
        api.panes()[0]?.setStretchFactor(2.4);
        api.panes()[1]?.setStretchFactor(1);
        api.panes()[2]?.setStretchFactor(1);
      }
      const values = wilderRsi(closes as number[], RSI_LENGTH);
      current.rsi.setData(
        sorted
          .map((p, i) => ({ time: toChartTime(p.time), value: values[i] }))
          .filter((point): point is { time: UTCTimestamp; value: number } => point.value != null)
      );
    }

    const newest = sorted.length ? sorted[sorted.length - 1].time : null;
    const firstLoad = newestTime.current === null;
    const advanced = newest !== newestTime.current;
    newestTime.current = newest;
    const timeScale = chart.current?.timeScale();
    if (!timeScale) return;
    if (firstLoad) timeScale.fitContent();
    else if (advanced && timeScale.scrollPosition() >= 0) timeScale.scrollToRealTime();
  }, [sorted]);

  return (
    <div className="chart-wrap">
      <div ref={container} className="chart-surface" />
    </div>
  );
}
