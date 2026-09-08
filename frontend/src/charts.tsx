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

const COLORS = {
  up: "#71e1c1",
  down: "#ff8f7b",
  macd: "#d6ad5c",
  signal: "#f0d695",
  text: "#8ea39d",
  grid: "rgba(142, 163, 157, 0.08)",
  crosshair: "rgba(214, 173, 92, 0.5)"
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
    const apply = () => chart.current?.applyOptions({ width: element.clientWidth });
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
  height?: number;
}

/** Candlesticks on top, MACD (histogram + MACD + signal) below, alerts as arrows on the candles. */
export function CandleChart({ candles, alerts, symbol, timeframe, height = 460 }: CandleChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    hist: ISeriesApi<"Histogram">;
    macd: ISeriesApi<"Line">;
    signal: ISeriesApi<"Line">;
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
    const signal = api.addSeries(LineSeries, { color: COLORS.signal, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, 1);
    const panes = api.panes();
    panes[0]?.setStretchFactor(2.2);
    panes[1]?.setStretchFactor(1);
    const markers = createSeriesMarkers(candleSeries, []);
    chart.current = api;
    series.current = { candles: candleSeries, hist, macd, signal, markers };
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height]);

  useResize(container, chart);
  const newestTime = useRef<string | null>(null);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    current.candles.setData(
      candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    current.hist.setData(
      candles
        .filter((c) => c.histogram != null)
        .map((c) => ({ time: toChartTime(c.time), value: c.histogram as number, color: (c.histogram as number) >= 0 ? "rgba(113,225,193,0.55)" : "rgba(255,143,123,0.55)" }))
    );
    current.macd.setData(candles.filter((c) => c.macd != null).map((c) => ({ time: toChartTime(c.time), value: c.macd as number })));
    current.signal.setData(candles.filter((c) => c.signal != null).map((c) => ({ time: toChartTime(c.time), value: c.signal as number })));

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

  const last = candles.length ? candles[candles.length - 1] : null;
  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span><i style={{ background: COLORS.macd }} /> MACD {last?.macd?.toFixed(4) ?? "—"}</span>
        <span><i style={{ background: COLORS.signal }} /> Signal {last?.signal?.toFixed(4) ?? "—"}</span>
        <span><i style={{ background: (last?.histogram ?? 0) >= 0 ? COLORS.up : COLORS.down }} /> Hist {last?.histogram?.toFixed(4) ?? "—"}</span>
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

/** MACD-only chart for SET tickers (the free scanner gives no OHLC history). */
export function MacdChart({ points, height = 260 }: MacdChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ hist: ISeriesApi<"Histogram">; macd: ISeriesApi<"Line">; signal: ISeriesApi<"Line"> } | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const api = createChart(container.current, baseOptions(height));
    const hist = api.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: false });
    const macd = api.addSeries(LineSeries, { color: COLORS.macd, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
    const signal = api.addSeries(LineSeries, { color: COLORS.signal, lineWidth: 1, priceLineVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
    chart.current = api;
    series.current = { hist, macd, signal };
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height]);

  useResize(container, chart);
  const newestTime = useRef<string | null>(null);

  const sorted = useMemo(() => [...points].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), [points]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    current.hist.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.histogram, color: p.histogram >= 0 ? "rgba(113,225,193,0.55)" : "rgba(255,143,123,0.55)" })));
    current.macd.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.macd })));
    current.signal.setData(sorted.map((p) => ({ time: toChartTime(p.time), value: p.signal })));
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
