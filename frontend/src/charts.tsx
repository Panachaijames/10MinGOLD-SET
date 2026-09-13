import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
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

const RSI_LENGTH = 14;

const COLORS = {
  up: "#71e1c1",
  down: "#ff8f7b",
  macd: "#2962ff",
  signal: "#ff6d00",
  rsi: "#b388ff",
  band: "rgba(179, 136, 255, 0.35)",
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
}

/** Candlesticks on top, MACD (histogram + MACD + signal) below, alerts as arrows on the candles. */
export function CandleChart({ candles, alerts, symbol, timeframe, forming, priceStatus = "closed", height = 560 }: CandleChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    hist: ISeriesApi<"Histogram">;
    macd: ISeriesApi<"Line">;
    signal: ISeriesApi<"Line">;
    rsi: ISeriesApi<"Line">;
    markers: ISeriesMarkersPluginApi<Time>;
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
    const hist = api.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: false }, 1);
    const macd = api.addSeries(LineSeries, { color: COLORS.macd, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, 1);
    const signal = api.addSeries(LineSeries, { color: COLORS.signal, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, 1);
    // Pane 2: RSI. The scale is pinned to 0-100 so the 30/70 guides sit where the eye
    // expects them instead of drifting with whatever range the visible bars happen to cover.
    const rsi = api.addSeries(LineSeries, {
      color: COLORS.rsi,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
    }, 2);
    for (const level of [70, 30]) {
      rsi.createPriceLine({ price: level, color: COLORS.band, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
    }
    const panes = api.panes();
    panes[0]?.setStretchFactor(2.6);
    panes[1]?.setStretchFactor(1);
    panes[2]?.setStretchFactor(1);
    const markers = createSeriesMarkers(candleSeries, []);
    chart.current = api;
    series.current = { candles: candleSeries, hist, macd, signal, rsi, markers };
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
    current.hist.setData(
      candles
        .filter((c) => c.histogram != null)
        .map((c) => ({ time: toChartTime(c.time), value: c.histogram as number, color: (c.histogram as number) >= 0 ? "rgba(113,225,193,0.55)" : "rgba(255,143,123,0.55)" }))
    );
    current.macd.setData(candles.filter((c) => c.macd != null).map((c) => ({ time: toChartTime(c.time), value: c.macd as number })));
    current.signal.setData(candles.filter((c) => c.signal != null).map((c) => ({ time: toChartTime(c.time), value: c.signal as number })));
    const rsiValues = wilderRsi(candles.map((c) => c.close), RSI_LENGTH);
    current.rsi.setData(
      candles
        .map((c, i) => ({ time: toChartTime(c.time), value: rsiValues[i] }))
        .filter((point): point is { time: UTCTimestamp; value: number } => point.value != null)
    );

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
  }, [candles, alerts, symbol, timeframe]);

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
  const livePrice = forming ? forming.close : last?.close;
  const live = Boolean(forming);
  const priceLabel = live ? "LIVE" : priceStatus === "delayed" ? "DELAYED CLOSE" : "CLOSED";
  const lastRsi = useMemo(() => {
    const values = wilderRsi(candles.map((c) => c.close), RSI_LENGTH);
    return values.length ? values[values.length - 1] : null;
  }, [candles]);
  const rsiTone = lastRsi == null ? COLORS.rsi : lastRsi >= 70 ? COLORS.down : lastRsi <= 30 ? COLORS.up : COLORS.rsi;
  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        {livePrice != null && (
          <span className={`price-badge ${live ? "live" : priceStatus}`}>
            {live && <span className="live-dot" />} {priceLabel} {livePrice.toFixed(2)}
          </span>
        )}
        <span><i style={{ background: COLORS.macd }} /> MACD {last?.macd?.toFixed(4) ?? "—"}</span>
        <span><i style={{ background: COLORS.signal }} /> Signal {last?.signal?.toFixed(4) ?? "—"}</span>
        <span><i style={{ background: (last?.histogram ?? 0) >= 0 ? COLORS.up : COLORS.down }} /> Hist {last?.histogram?.toFixed(4) ?? "—"}</span>
        <span><i style={{ background: rsiTone }} /> RSI({RSI_LENGTH}) {lastRsi?.toFixed(1) ?? "—"}{lastRsi == null ? "" : lastRsi >= 70 ? " overbought" : lastRsi <= 30 ? " oversold" : ""}</span>
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
