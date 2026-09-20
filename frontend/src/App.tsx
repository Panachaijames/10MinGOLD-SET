import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertChannel,
  AlertRecord,
  CandleSeries,
  Direction,
  PublicConfig,
  NotificationPrefs,
  SetTickerState,
  StatusResponse,
  SymbolHit,
  WATCH_TIMEFRAMES,
  WatchlistEntry,
  shortSymbol,
  timeframeLabel
} from "./api";
import { createBackend } from "./backend";
import { CandleChart, DEFAULT_INDICATORS, INDICATORS, orderIndicators, type IndicatorKey } from "./charts";
import type { AccessCode, AccessMember } from "./backend";
import { t, useLang } from "./i18n";

const backend = createBackend();
const BITCOIN_SYMBOL = "BINANCE:BTCUSDT";
const SUPPORTED_TIMEFRAMES = new Set<number>(WATCH_TIMEFRAMES.map((frame) => frame.minutes));
const GOLD_TIMEFRAMES = [10, 15];

type ChartInstrumentKind = "gold" | "set" | "bitcoin" | "watch";

interface ChartInstrument {
  kind: ChartInstrumentKind;
  symbol: string;
  timeframe: number;
}

function candleSeriesKey(symbol: string, timeframe: number): string {
  return `${symbol}|${timeframe}`;
}

/** SET's anonymous feed is 15 minutes behind; everything else the scanner reads is current. */
function isDelayedSymbol(symbol: string): boolean {
  return symbol.startsWith("SET:");
}

/**
 * Split "EXCHANGE:SYMBOL:TIMEFRAME" into its parts.
 *
 * The ticker contains a colon of its own, so the timeframe comes off the end rather than the
 * symbol off the front. A key with no timeframe at all is one saved by an older version, which
 * only ever meant M15.
 */
function splitSymbolAndTimeframe(rest: string, fallback: number): { symbol: string; timeframe: number } | null {
  const cut = rest.lastIndexOf(":");
  if (cut > 0) {
    const timeframe = Number(rest.slice(cut + 1));
    if (SUPPORTED_TIMEFRAMES.has(timeframe)) return { symbol: rest.slice(0, cut), timeframe };
  }
  return rest ? { symbol: rest, timeframe: fallback } : null;
}

function chartInstrument(paneKey: string, goldSymbol: string): ChartInstrument | null {
  if (paneKey.startsWith("gold:")) {
    const timeframe = Number(paneKey.slice(5));
    return SUPPORTED_TIMEFRAMES.has(timeframe) ? { kind: "gold", symbol: goldSymbol, timeframe } : null;
  }
  if (paneKey.startsWith("btc:")) {
    const timeframe = Number(paneKey.slice(4));
    return SUPPORTED_TIMEFRAMES.has(timeframe) ? { kind: "bitcoin", symbol: BITCOIN_SYMBOL, timeframe } : null;
  }
  if (paneKey.startsWith("set:")) {
    const parts = splitSymbolAndTimeframe(paneKey.slice(4), 15);
    return parts ? { kind: "set", symbol: parts.symbol, timeframe: parts.timeframe } : null;
  }
  if (paneKey.startsWith("watch:")) {
    const parts = splitSymbolAndTimeframe(paneKey.slice(6), 15);
    return parts ? { kind: "watch", symbol: parts.symbol, timeframe: parts.timeframe } : null;
  }
  return null;
}

function watchPaneKey(symbol: string, timeframe: number): string {
  return `watch:${symbol}:${timeframe}`;
}

/**
 * A chart pane is chosen as two independent things — which instrument, and which timeframe —
 * rather than as one combined entry. The pane key stays the single string the saved layout has
 * always used; these two functions are what take it apart and put it back together.
 */
export interface PaneSymbol {
  /** Identifies the instrument alone: "gold", "btc", "set:SET:PTT", "watch:BINANCE:BTCUSDT". */
  key: string;
  label: string;
  timeframes: number[];
}

function paneSymbolKey(paneKey: string): string {
  if (paneKey.startsWith("gold:")) return "gold";
  if (paneKey.startsWith("btc:")) return "btc";
  for (const prefix of ["set:", "watch:"]) {
    if (!paneKey.startsWith(prefix)) continue;
    const parts = splitSymbolAndTimeframe(paneKey.slice(prefix.length), 15);
    return parts ? `${prefix}${parts.symbol}` : paneKey;
  }
  return paneKey;
}

function composePaneKey(symbolKey: string, timeframe: number): string {
  if (symbolKey === "gold") return `gold:${timeframe}`;
  if (symbolKey === "btc") return `btc:${timeframe}`;
  if (symbolKey.startsWith("set:") || symbolKey.startsWith("watch:")) return `${symbolKey}:${timeframe}`;
  return symbolKey;
}

function chartInstrumentLabel(paneKey: string, goldSymbol: string): string {
  const instrument = chartInstrument(paneKey, goldSymbol);
  if (!instrument) return paneKey;
  if (instrument.kind === "gold") return `${goldSymbol} · ${timeframeLabel(instrument.timeframe)}`;
  if (instrument.kind === "bitcoin") return `BTCUSDT · ${timeframeLabel(instrument.timeframe)}`;
  const suffix = isDelayedSymbol(instrument.symbol) ? " · delayed" : "";
  return `${shortSymbol(instrument.symbol)} · ${timeframeLabel(instrument.timeframe)}${suffix}`;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    outputArray[i] = raw.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToUrlBase64(value: ArrayBuffer | null): string {
  if (!value) return "";
  const binary = Array.from(new Uint8Array(value), (byte) => String.fromCharCode(byte)).join("");
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function formatTime(value: string | null | undefined, seconds = false): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {})
  }).format(new Date(value));
}

function formatLatency(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function formatAgo(value: string | null | undefined, now: number): string {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

function StatusDot({ live }: { live: boolean }) {
  return <span className={`status-dot ${live ? "live" : "offline"}`} aria-hidden="true" />;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg>
  );
}

interface ShareAppDialogProps {
  open: boolean;
  onClose: () => void;
}

function ShareAppDialog({ open, onClose }: ShareAppDialogProps) {
  // Share only the public app origin. Never put an auth token, alert id, or current query string
  // into a QR code that may be photographed or forwarded.
  const appUrl = useMemo(() => new URL("/", window.location.origin).href, []);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [feedback, setFeedback] = useState("");
  const localOnly = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const nativeShare = (navigator as unknown as { share?: (data: ShareData) => Promise<void> }).share;
  const canShare = typeof nativeShare === "function";

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(appUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 224,
      color: { dark: "#061310ff", light: "#ffffffff" }
    })
      .then((value) => { if (!cancelled) setQrDataUrl(value); })
      .catch(() => { if (!cancelled) setFeedback("Could not generate the QR code."); });
    return () => { cancelled = true; };
  }, [appUrl]);

  useEffect(() => {
    if (!open) return;
    setFeedback("");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  const shareOrCopy = async () => {
    try {
      if (nativeShare) {
        await nativeShare.call(navigator, { title: "Aurum Signal", text: "Open the Aurum Signal web app", url: appUrl });
        setFeedback("App link shared.");
      } else {
        await navigator.clipboard.writeText(appUrl);
        setFeedback("App link copied.");
      }
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setFeedback("Could not share automatically. Copy the URL shown below.");
    }
  };

  if (!open) return null;
  return (
    <div className="share-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section id="share-app-dialog" className="share-dialog panel" role="dialog" aria-modal="true" aria-labelledby="share-app-title">
        <button className="share-close" type="button" onClick={onClose} aria-label={t("Close QR code")} autoFocus>×</button>
        <span className="eyebrow">{t("Open on another device")}</span>
        <h2 id="share-app-title">{t("Scan to open Aurum Signal")}</h2>
        <p>The QR opens this web app. Then install it from your phone browser to give it its own Home Screen icon.</p>
        <div className="qr-frame">
          {qrDataUrl ? <img src={qrDataUrl} width="224" height="224" alt={`QR code for ${appUrl}`} /> : <span>{t("Generating QR…")}</span>}
        </div>
        <code className="share-url">{appUrl}</code>
        {localOnly && <p className="share-warning">This preview points to this computer only. Deploy to Vercel first; the QR will automatically use the final Vercel address.</p>}
        <div className="share-actions">
          <button className="primary" type="button" onClick={shareOrCopy}>{canShare ? "Share link" : "Copy link"}</button>
          <button className="ghost" type="button" onClick={onClose}>{t("Done")}</button>
        </div>
        <ol className="install-steps">
          <li><strong>{t("Android:")}</strong> open in Chrome, then tap Install app or Add to Home screen.</li>
          <li><strong>iPhone/iPad:</strong> open in Safari, tap Share, then Add to Home Screen.</li>
          <li>{t("Open the installed icon, sign in, and tap Enable notifications.")}</li>
        </ol>
        {feedback && <div className="share-feedback" role="status">{feedback}</div>}
      </section>
    </div>
  );
}

interface LineBotDialogProps {
  open: boolean;
  onClose: () => void;
  config: PublicConfig | null;
  onSendTest: () => Promise<void>;
  loading: boolean;
}

function LineBotDialog({ open, onClose, config, onSendTest, loading }: LineBotDialogProps) {
  const addUrl =
    config?.line_bot_add_url ||
    (config?.line_bot_id ? `https://line.me/R/ti/p/@${config.line_bot_id.replace(/^@/, "")}` : "https://lin.ee/tQIeBjo");
  const [qrDataUrl, setQrDataUrl] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    QRCode.toDataURL(addUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 224,
      color: { dark: "#061310ff", light: "#ffffffff" }
    })
      .then((val) => { if (!cancelled) setQrDataUrl(val); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, addUrl]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="share-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="share-dialog panel" role="dialog" aria-modal="true" aria-labelledby="line-bot-title">
        <button className="share-close" type="button" onClick={onClose} aria-label={t("Close")} autoFocus>×</button>
        <span className="eyebrow" style={{ color: "#06c755" }}>{t("LINE Messaging API")}</span>
        <h2 id="line-bot-title">{t("Add Aurum Signal Bot")}</h2>
        <p>{t("Scan this QR code with your phone or tap the button to add the bot on LINE.")}</p>
        <div className="qr-frame">
          {qrDataUrl ? <img src={qrDataUrl} width="224" height="224" alt="LINE Bot QR code" /> : <span>{t("Generating QR…")}</span>}
        </div>
        {config?.line_bot_id && <code className="share-url">LINE Basic ID: {config.line_bot_id}</code>}
        <div className="share-actions">
          <a
            className="primary"
            href={addUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none", textAlign: "center", display: "inline-block", background: "#06c755", borderColor: "#06c755", color: "#fff" }}
          >{t("Open in LINE")}</a>
          <button className="ghost" type="button" disabled={loading} onClick={onSendTest}>
            {loading ? t("Sending…") : t("Test LINE Alert")}
          </button>
        </div>
        <ol className="install-steps">
          <li>{t("Scan the QR code with your LINE app or tap")}<strong>{t("Open in LINE")}</strong>.</li>
          <li>{t("Tap")}<strong>{t("Add Friend")}</strong> to start receiving alerts.</li>
          <li>{t("Tap")}<strong>{t("Test LINE Alert")}</strong> above to verify notifications on your phone!</li>
        </ol>
      </section>
    </div>
  );
}

function alertHeadline(alert: AlertRecord): string {
  if (alert.direction === "info") return alert.title || "System notice";
  const prefix = alert.source === "gold_cloud"
    ? "Cloud feed · "
    : alert.source && alert.source !== "gold_mt5"
      ? `${shortSymbol(alert.symbol)} · `
      : "";
  return `${prefix}${alert.direction === "bearish" ? "▼ Bearish" : "▲ Bullish"} MACD crossover`;
}

interface QuietHoursPanelProps {
  prefs: NotificationPrefs | null;
  onSaved: (prefs: NotificationPrefs) => void;
}

/**
 * A daily window in which nothing is pushed, for the whole account rather than per instrument.
 *
 * It suppresses delivery, not detection: the crossover is still found, still charted and still
 * in the alert history when the window ends. That is the point — an overnight crypto signal is
 * worth having in the morning even when it is not worth waking up for.
 */
function QuietHoursPanel({ prefs, onSaved }: QuietHoursPanelProps) {
  const [from, setFrom] = useState(prefs?.quiet_from ?? "");
  const [to, setTo] = useState(prefs?.quiet_to ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setFrom(prefs?.quiet_from ?? "");
    setTo(prefs?.quiet_to ?? "");
  }, [prefs?.quiet_from, prefs?.quiet_to]);

  const zone = prefs?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok";
  const dirty = (prefs?.quiet_from ?? "") !== from || (prefs?.quiet_to ?? "") !== to;

  const save = async (nextFrom: string, nextTo: string) => {
    if (!backend.saveNotificationPrefs) return;
    setSaving(true);
    setMessage("");
    try {
      await backend.saveNotificationPrefs({ quiet_from: nextFrom || null, quiet_to: nextTo || null, time_zone: zone });
      onSaved({ quiet_from: nextFrom || null, quiet_to: nextTo || null, time_zone: zone, line_connected: prefs?.line_connected ?? false });
      setMessage(nextFrom ? t("Quiet hours saved.") : t("Quiet hours turned off."));
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel quiet-panel">
      <div className="quiet-row">
        <div className="quiet-copy">
          <strong>{t("Quiet hours")}</strong>
          <span>{t("No notifications inside this window. Alerts still appear in the history and on the charts.")}</span>
        </div>
        <div className="quiet-controls">
          <label>
            <span>{t("From")}</span>
            <input type="time" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            <span>{t("To")}</span>
            <input type="time" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button className="primary" disabled={saving || !dirty} onClick={() => void save(from, to)}>
            {saving ? t("Saving…") : t("Save")}
          </button>
          {(prefs?.quiet_from || from) && (
            <button className="ghost small" disabled={saving} onClick={() => { setFrom(""); setTo(""); void save("", ""); }}>
              {t("Turn off")}
            </button>
          )}
        </div>
      </div>
      <p className="watch-hint">{t("Times are in")} {zone}.</p>
      {message && <p className="watch-hint">{message}</p>}
    </section>
  );
}

interface WatchlistPanelProps {
  entries: WatchlistEntry[];
  error: string;
  /** True when this account actually has somewhere for LINE messages to go. */
  lineAvailable: boolean;
  onChanged: () => void;
  onSelect: (symbol: string, timeframe: number) => void;
}

/**
 * One instrument, with the timeframes it is watched on.
 *
 * The database stores a row per symbol and timeframe, because that is the granularity the scanner
 * and the alert ids work at. A person does not think that way: they add a stock, then decide
 * which candles should alert them. Grouping here is what makes those two separate settings.
 */
interface WatchGroup {
  symbol: string;
  label: string | null;
  /** One entry per watched timeframe, shortest first. */
  entries: WatchlistEntry[];
  timeframes: number[];
  notify: boolean;
  directions: Direction[];
  channels: AlertChannel[];
}

function groupWatchlist(entries: WatchlistEntry[]): WatchGroup[] {
  const groups = new Map<string, WatchlistEntry[]>();
  for (const entry of entries) {
    groups.set(entry.symbol, [...(groups.get(entry.symbol) ?? []), entry]);
  }
  return [...groups.entries()].map(([symbol, rows]) => {
    const sorted = [...rows].sort((a, b) => a.timeframe_minutes - b.timeframe_minutes);
    // Delivery settings are written to every row of a symbol at once, so the first row speaks
    // for all of them; a row inserted before the columns existed reads as the default.
    const first = sorted[0];
    return {
      symbol,
      label: sorted.find((row) => row.label)?.label ?? null,
      entries: sorted,
      timeframes: sorted.map((row) => row.timeframe_minutes),
      notify: first.notify,
      directions: first.directions,
      channels: first.channels
    };
  });
}

/** What a group's delivery settings add up to, in the width of a table cell. */
function alertSummary(group: WatchGroup): string {
  if (!group.notify) return t("Muted");
  const direction = group.directions.length === 2
    ? "▲▼"
    : group.directions[0] === "bullish" ? "▲" : "▼";
  const channels = group.channels.map((channel) => (channel === "push" ? t("Push") : "LINE")).join(" + ");
  return `${direction} · ${channels}`;
}

/**
 * Add any instrument, on any supported timeframe, without anybody configuring anything.
 *
 * The list is per member: the cloud scanner reads each distinct instrument once however many
 * people watch it, and the fan-out sends the resulting alert only to the people who asked for
 * it. Removing a row stops the notifications for this account and nobody else's.
 */
function WatchlistPanel({ entries, error, lineAvailable, onChanged, onSelect }: WatchlistPanelProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [addFrames, setAddFrames] = useState<number[]>([15]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const searchToken = useRef(0);

  // Search on a pause in typing rather than on every keystroke: each call is a request the
  // function forwards to TradingView on the project's behalf.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2 || !backend.searchSymbols) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const token = ++searchToken.current;
    const timer = window.setTimeout(async () => {
      try {
        const results = await backend.searchSymbols!(text);
        if (searchToken.current === token) {
          setHits(results);
          setMessage(results.length ? "" : t("No instrument matched that search."));
        }
      } catch (searchError) {
        if (searchToken.current === token) {
          setHits([]);
          setMessage(searchError instanceof Error ? searchError.message : String(searchError));
        }
      } finally {
        if (searchToken.current === token) setSearching(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  const add = async (hit: SymbolHit) => {
    if (!backend.addWatch || !addFrames.length) return;
    setBusy(hit.ticker);
    setMessage("");
    const chosen = [...addFrames].sort((a, b) => a - b);
    const added: number[] = [];
    try {
      // One row per timeframe, because that is what the scanner and the alert ids work at. The
      // partial result is reported rather than discarded: a cap reached halfway through should
      // not look like nothing happened.
      for (const frame of chosen) {
        await backend.addWatch({ symbol: hit.ticker, timeframe: frame, label: hit.description || hit.symbol });
        added.push(frame);
      }
      setQuery("");
      setHits([]);
      setMessage(
        `${shortSymbol(hit.ticker)} ${added.map(timeframeLabel).join(", ")} ${t("added. The next scan covers it.")}`
      );
    } catch (addError) {
      const detail = addError instanceof Error ? addError.message : String(addError);
      setMessage(added.length ? `${added.map(timeframeLabel).join(", ")} added. ${detail}` : detail);
    } finally {
      onChanged();
      setBusy("");
    }
  };

  /**
   * Delivery settings save on click rather than behind a Save button: each one is a single
   * independent field, and a half-applied set of alert rules is worse than none.
   */
  const patch = async (
    group: WatchGroup,
    changes: Partial<Pick<WatchlistEntry, "notify" | "directions" | "channels">>
  ) => {
    if (!backend.updateWatchSymbol) return;
    setBusy(group.symbol);
    setMessage("");
    try {
      await backend.updateWatchSymbol(group.symbol, changes);
      onChanged();
    } catch (patchError) {
      setMessage(patchError instanceof Error ? patchError.message : String(patchError));
    } finally {
      setBusy("");
    }
  };

  /**
   * Watching a timeframe is adding a row; not watching it is deleting one. Keeping that as the
   * storage shape means the scanner, the alert ids and the charts all stay exactly as they were.
   */
  const toggleTimeframe = async (group: WatchGroup, timeframe: number) => {
    const existing = group.entries.find((entry) => entry.timeframe_minutes === timeframe);
    if (existing && group.timeframes.length === 1) {
      setMessage(t("Keep at least one timeframe, or remove the instrument."));
      return;
    }
    setBusy(group.symbol);
    setMessage("");
    try {
      if (existing) {
        await backend.removeWatch?.(existing.id);
      } else {
        await backend.addWatch?.({ symbol: group.symbol, timeframe, label: group.label });
        // A new row starts at the database defaults, so bring it in line with the rest.
        await backend.updateWatchSymbol?.(group.symbol, {
          notify: group.notify,
          directions: group.directions,
          channels: group.channels
        });
      }
      onChanged();
    } catch (toggleError) {
      setMessage(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusy("");
    }
  };

  /** Toggle one value in a list that is not allowed to become empty. */
  const toggleIn = <T,>(list: T[], value: T): T[] | null => {
    const next = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
    return next.length ? next : null;
  };

  const groups = useMemo(() => groupWatchlist(entries), [entries]);

  const remove = async (group: WatchGroup) => {
    if (!backend.removeWatchSymbol) return;
    setBusy(group.symbol);
    try {
      await backend.removeWatchSymbol(group.symbol);
      setMessage("");
      onChanged();
    } catch (removeError) {
      setMessage(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="panel watchlist-panel">
      {error && <div className="message error"><span>{error}</span></div>}
      <div className="watch-search">
        <input
          type="search"
          value={query}
          placeholder={t("Search any symbol: PTT, AAPL, BTCUSDT…")}
          aria-label={t("Search instruments")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="watch-option watch-add-frames" role="group" aria-label={t("Timeframe for the instrument you add")}>
        <span className="watch-option-label">{t("Alert me on")}</span>
        {WATCH_TIMEFRAMES.map((frame) => {
          const on = addFrames.includes(frame.minutes);
          return (
            <button
              key={frame.minutes}
              type="button"
              className={on ? "chip on" : "chip"}
              aria-pressed={on}
              onClick={() => {
                const next = toggleIn(addFrames, frame.minutes);
                // Computed outside the updater: a state updater has to stay pure, and React
                // invokes it twice in development.
                if (!next) {
                  setMessage(t("Choose at least one timeframe."));
                  return;
                }
                setMessage("");
                setAddFrames(next);
              }}
            >
              {frame.label}
            </button>
          );
        })}
      </div>
      {searching && <p className="watch-hint">{t("Searching…")}</p>}
      {message && <p className="watch-hint">{message}</p>}
      {hits.length > 0 && (
        <ul className="watch-results">
          {hits.map((hit) => (
            <li key={hit.ticker}>
              <button type="button" onClick={() => add(hit)} disabled={busy === hit.ticker}>
                <span className="watch-result-symbol">{hit.symbol}</span>
                <span className="watch-result-detail">{hit.description || hit.type}</span>
                <span className="watch-result-exchange">{hit.exchange}</span>
                <span className="watch-result-add">
                  {busy === hit.ticker
                    ? "…"
                    : "+ " + [...addFrames].sort((a, b) => a - b).map(timeframeLabel).join(" ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <table className="set-table watch-table">
        <thead>
          <tr>
            <th>{t("Instrument")}</th><th>{t("Timeframes")}</th><th>{t("Alerts")}</th><th />
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 ? (
            <tr>
              <td className="empty-cell" colSpan={4}>
                {t("Nothing on your list yet. Search above to add an instrument.")}
              </td>
            </tr>
          ) : groups.flatMap((group) => [
            <tr
              key={group.symbol}
              className="selectable"
              onClick={() => setEditing((current) => (current === group.symbol ? null : group.symbol))}
            >
              <td>
                {shortSymbol(group.symbol)}
                {isDelayedSymbol(group.symbol) && <span className="tag-delayed">{t("delayed")}</span>}
                {group.label && <span className="watch-row-label">{group.label}</span>}
              </td>
              <td>
                <span className="watch-frames">
                  {group.timeframes.map((frame) => (
                    <span key={frame} className="frame-tag">{timeframeLabel(frame)}</span>
                  ))}
                </span>
              </td>
              <td>
                <span className={group.notify ? "chip on alert-summary" : "chip alert-summary"}>
                  {alertSummary(group)}
                </span>
              </td>
              <td>
                <button
                  className="ghost small"
                  disabled={busy === group.symbol}
                  onClick={(event) => { event.stopPropagation(); void remove(group); }}
                  aria-label={t("Remove") + " " + group.symbol}
                >
                  {busy === group.symbol ? "…" : t("Remove")}
                </button>
              </td>
            </tr>,
            editing === group.symbol ? (
              <tr key={group.symbol + ":settings"} className="watch-settings">
                <td colSpan={4}>
                  <div className="watch-settings-grid">
                    <div className="watch-option" role="group" aria-label={t("Timeframes")}>
                      <span className="watch-option-label">{t("Alert me on")}</span>
                      {WATCH_TIMEFRAMES.map((frame) => {
                        const on = group.timeframes.includes(frame.minutes);
                        return (
                          <button
                            key={frame.minutes}
                            type="button"
                            className={on ? "chip on" : "chip"}
                            aria-pressed={on}
                            disabled={busy === group.symbol}
                            onClick={() => void toggleTimeframe(group, frame.minutes)}
                          >
                            {frame.label}
                          </button>
                        );
                      })}
                    </div>

                    <label className="watch-toggle">
                      <input
                        type="checkbox"
                        checked={group.notify}
                        disabled={busy === group.symbol}
                        onChange={(event) => void patch(group, { notify: event.target.checked })}
                      />
                      <span>{t("Notify me")}</span>
                    </label>

                    <div className="watch-option" role="group" aria-label={t("Directions")}>
                      <span className="watch-option-label">{t("Direction")}</span>
                      {(["bullish", "bearish"] as const).map((direction) => (
                        <button
                          key={direction}
                          type="button"
                          className={group.directions.includes(direction) ? "chip on" : "chip"}
                          aria-pressed={group.directions.includes(direction)}
                          disabled={!group.notify || busy === group.symbol}
                          onClick={() => {
                            const next = toggleIn(group.directions, direction);
                            // Turning off the last direction would mean "notify me about
                            // nothing", which is what the mute is for.
                            if (!next) setMessage(t("Keep at least one direction, or mute the instrument."));
                            else void patch(group, { directions: next });
                          }}
                        >
                          {direction === "bullish" ? "▲ " + t("Bullish") : "▼ " + t("Bearish")}
                        </button>
                      ))}
                    </div>

                    <div className="watch-option" role="group" aria-label={t("Channels")}>
                      <span className="watch-option-label">{t("Send to")}</span>
                      {(["push", "line"] as const).map((channel) => {
                        const unavailable = channel === "line" && !lineAvailable;
                        return (
                          <button
                            key={channel}
                            type="button"
                            className={group.channels.includes(channel) ? "chip on" : "chip"}
                            aria-pressed={group.channels.includes(channel)}
                            disabled={!group.notify || busy === group.symbol || unavailable}
                            title={unavailable ? t("This account has no LINE destination yet.") : undefined}
                            onClick={() => {
                              const next = toggleIn(group.channels, channel);
                              if (!next) setMessage(t("Keep at least one channel, or mute the instrument."));
                              else void patch(group, { channels: next });
                            }}
                          >
                            {channel === "push" ? t("Push") : "LINE"}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <table className="watch-frame-state">
                    <tbody>
                      {group.entries.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            <button
                              className="linklike"
                              onClick={() => onSelect(entry.symbol, entry.timeframe_minutes)}
                            >
                              {timeframeLabel(entry.timeframe_minutes)}
                            </button>
                          </td>
                          <td>MACD {entry.macd?.toFixed(4) ?? "—"}</td>
                          <td className={(entry.histogram ?? 0) >= 0 ? "mint" : "coral"}>
                            {t("Hist")} {entry.histogram?.toFixed(4) ?? "—"}
                          </td>
                          <td>{formatTime(entry.last_bar_time, false)}</td>
                          <td>
                            {entry.last_error && (
                              <span className="watch-row-error" title={entry.last_error}>{entry.last_error}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="watch-hint">
                    {t("Muting keeps the instrument scanned and charted; only the notification stops.")}
                  </p>
                </td>
              </tr>
            ) : null
          ])}
        </tbody>
      </table>
    </section>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const { lang, setLang } = useLang();
  const [passcodeDraft, setPasscodeDraft] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [access, setAccess] = useState<{ codes: AccessCode[]; members: AccessMember[] }>({ codes: [], members: [] });
  const [issuedCode, setIssuedCode] = useState("");
  const [codeLabel, setCodeLabel] = useState("guest");
  const [codeDays, setCodeDays] = useState(30);
  const [accessError, setAccessError] = useState("");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(window.matchMedia("(display-mode: standalone)").matches);
  const [shareOpen, setShareOpen] = useState(false);
  const [lineModalOpen, setLineModalOpen] = useState(false);
  const [layout, setLayout] = useState<number>(() => Number(localStorage.getItem("aurum-layout")) || 1);
  const [panes, setPanes] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("aurum-panes") || "null");
      if (Array.isArray(saved) && saved.every((value) => typeof value === "string")) return saved as string[];
    } catch {
      // A corrupt entry just falls through to the default arrangement.
    }
    return ["gold:10", "gold:15", "gold:10", "gold:15"];
  });
  const [expanded, setExpanded] = useState(false);
  const [indicators, setIndicators] = useState<IndicatorKey[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("aurum-indicators") || "null");
      if (Array.isArray(saved)) return orderIndicators(saved.filter((value) => typeof value === "string"));
    } catch {
      // A corrupt entry just falls through to the default pair.
    }
    return DEFAULT_INDICATORS;
  });
  const [candleSeries, setCandleSeries] = useState<Record<string, CandleSeries>>({});
  const [chartError, setChartError] = useState("");
  const [fetchingCandles, setFetchingCandles] = useState(false);
  // Symbol|timeframe pairs already asked for on demand, so one unavailable series cannot turn
  // every refresh into another round of requests.
  const fetchAttempts = useRef(new Set<string>());
  const [setTickers, setSetTickers] = useState<SetTickerState[]>([]);
  const [setPanelError, setSetPanelError] = useState("");
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [watchError, setWatchError] = useState("");
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs | null>(null);
  const highlightedAlert = useMemo(() => new URLSearchParams(window.location.search).get("alert"), []);
  const refreshing = useRef(false);
  const chartPanel = useRef<HTMLElement | null>(null);
  // Public config falls back to settings.gold_symbol even when there has never been an MT5
  // heartbeat, so prefer it when choosing the database key for cloud-only charts.
  const goldSymbol = config?.symbol || status?.watcher.symbol || "XAUUSDm";

  // Only the panes on screen are worth fetching: a 1-up gold chart should not pull nine SET
  // candle histories every refresh. The selected SET detail is added separately below.
  const visiblePanes = useMemo(() => {
    // A saved arrangement from an older version can be short; pad before slicing so a 4-up
    // never renders three cells.
    const filled = [...panes];
    while (filled.length < 4) filled.push(filled.length % 2 === 0 ? "gold:10" : "gold:15");
    return filled.slice(0, layout);
  }, [panes, layout]);
  const visibleInstruments = useMemo(
    () => visiblePanes
      .map((paneKey) => chartInstrument(paneKey, goldSymbol))
      .filter((value): value is ChartInstrument => value !== null),
    [visiblePanes, goldSymbol]
  );
  const loadWatchlist = useCallback(async () => {
    if (!authed || backend.kind !== "supabase") return;
    try {
      setWatchlist(await backend.watchlist());
      setWatchError("");
    } catch (listError) {
      setWatchError(listError instanceof Error ? listError.message : String(listError));
    }
  }, [authed]);

  useEffect(() => {
    if (!authed || !backend.notificationPrefs) return;
    let cancelled = false;
    // Preferences are small and rarely change, so they are loaded once per session rather than
    // on every refresh; the panel updates its own copy after a save.
    void backend.notificationPrefs()
      .then((prefs) => { if (!cancelled) setNotificationPrefs(prefs); })
      .catch(() => { if (!cancelled) setNotificationPrefs(null); });
    return () => { cancelled = true; };
  }, [authed]);

  // `refresh` must not take a dependency on the watchlist loader: it would then change identity
  // on every list edit and restart the polling effect below.
  const loadWatchlistRef = useRef(loadWatchlist);
  useEffect(() => {
    loadWatchlistRef.current = loadWatchlist;
    void loadWatchlist();
  }, [loadWatchlist]);

  const requestedInstruments = useMemo(() => {
    const requested = [
      ...visibleInstruments,
      ...(selectedSet ? [{ kind: "set" as const, symbol: selectedSet, timeframe: 15 }] : [])
    ].filter((instrument) => backend.kind === "supabase" || instrument.kind === "gold");
    return [...new Map(requested.map((instrument) => [
      candleSeriesKey(instrument.symbol, instrument.timeframe),
      instrument
    ])).values()];
  }, [visibleInstruments, selectedSet]);

  const loadRequestedCandles = useCallback(async () => {
    if (!authed || requestedInstruments.length === 0) return;
    const results = await Promise.allSettled(
      requestedInstruments.map(async (instrument) => ({
        instrument,
        series: await backend.candles(instrument.symbol, instrument.timeframe)
      }))
    );
    const loaded: Record<string, CandleSeries> = {};
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { instrument, series } = result.value;
        loaded[candleSeriesKey(instrument.symbol, instrument.timeframe)] = series;
      } else {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
    if (Object.keys(loaded).length) setCandleSeries((previous) => ({ ...previous, ...loaded }));
    setChartError([...new Set(failures)].join(" · "));

    // A timeframe nobody is alerted on has nothing stored for it. Ask the cloud to fetch it once,
    // then read it back. Attempts are remembered so a genuinely unavailable series is not
    // re-requested on every refresh.
    if (!backend.ensureCandles) return;
    const missing = Object.entries(loaded)
      .filter(([, series]) => series.candles.length === 0)
      .map(([key]) => key)
      .filter((key) => !fetchAttempts.current.has(key));
    if (!missing.length) return;
    for (const key of missing) fetchAttempts.current.add(key);
    setFetchingCandles(true);
    try {
      const filled: Record<string, CandleSeries> = {};
      for (const key of missing) {
        const instrument = requestedInstruments.find(
          (candidate) => candleSeriesKey(candidate.symbol, candidate.timeframe) === key
        );
        if (!instrument) continue;
        const ok = await backend.ensureCandles(instrument.symbol, instrument.timeframe);
        if (!ok) continue;
        filled[key] = await backend.candles(instrument.symbol, instrument.timeframe);
      }
      if (Object.keys(filled).length) setCandleSeries((previous) => ({ ...previous, ...filled }));
    } catch (fetchError) {
      setChartError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setFetchingCandles(false);
    }
  }, [authed, requestedInstruments]);

  // A light refresh is the one a watcher heartbeat triggers: it moves the forming candle and
  // nothing else, so it skips the alert list, the delivery counts and the latency sample.
  const refresh = useCallback(async (quiet = false, light = false) => {
    if (!authed || refreshing.current) return;
    refreshing.current = true;
    try {
      const [nextStatus, nextAlerts] = await Promise.all([
        backend.status({ light }),
        light ? Promise.resolve(null) : backend.alerts()
      ]);
      setStatus(nextStatus);
      if (nextAlerts) setAlerts(nextAlerts);
      setLastSuccessAt(Date.now());
      setError("");

      // Full polling and candle Realtime events read the rows that are actually on screen.
      // Heartbeat-only refreshes skip this query: their only chart change is gold's forming bar,
      // which is already carried inside the heartbeat status payload.
      if (!light) await loadRequestedCandles();

      if (backend.kind === "supabase" && !light) {
        try {
          setSetTickers(await backend.setTickers());
          setSetPanelError("");
        } catch (setError) {
          setSetPanelError(setError instanceof Error ? setError.message : String(setError));
        }
        // The watchlist's MACD column comes from the shared scanner, so it moves on the same
        // Realtime events as the charts rather than only when the member edits the list.
        await loadWatchlistRef.current();
      }
    } catch (requestError) {
      if (!quiet) setError(requestError instanceof Error ? requestError.message : "Unable to connect");
    } finally {
      refreshing.current = false;
    }
  }, [authed, loadRequestedCandles]);

  // The polling/Realtime effect below must not re-subscribe whenever refresh changes identity
  // (it does on every timeframe switch), so it always calls the latest refresh through a ref.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem("aurum-indicators", JSON.stringify(indicators));
    localStorage.setItem("aurum-layout", String(layout));
    localStorage.setItem("aurum-panes", JSON.stringify(panes));
  }, [layout, panes]);

  useEffect(() => {
    if (authed) void loadRequestedCandles();
  }, [authed, loadRequestedCandles]);

  useEffect(() => {
    if (!setTickers.length) {
      if (selectedSet) setSelectedSet("");
      return;
    }
    if (setTickers.length && !setTickers.some((row) => row.symbol === selectedSet)) {
      setSelectedSet(setTickers[0].symbol);
    }
  }, [setTickers, selectedSet]);

  const toggleExpanded = useCallback(() => {
    setExpanded((wasExpanded) => {
      const next = !wasExpanded;
      // Ask for real fullscreen where the browser allows it. iPadOS Safari refuses it on
      // anything but a video, so the CSS class is what actually guarantees a full-viewport
      // chart on the tablet; the request failing is not an error worth surfacing.
      if (next) void chartPanel.current?.requestFullscreen?.().catch(() => undefined);
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      return next;
    });
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => { if (!document.fullscreenElement) setExpanded(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    backend.hasSession().then(setAuthed).catch(() => setAuthed(false));
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setStandalone(true);
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!authed) return;
    backend.publicConfig().then(setConfig).catch((requestError) => setError(String(requestError)));
  }, [authed]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshRef.current();
    // Realtime (cloud) or polling (legacy). The poll stays on as a fallback in both modes.
    const timer = window.setInterval(() => void refreshRef.current(true), backend.onChange ? 30_000 : 2000);
    // Realtime emits one event per changed row (a watcher restart publishes hundreds of candles
    // at once), so events are coalesced into a single refresh per second.
    let debounce: number | undefined;
    // A heartbeat only carries the forming candle, so it gets the cheap refresh. An alert or a
    // new candle row gets the full one.
    let pendingLight = true;
    const unsubscribe = backend.onChange
      ? backend.onChange((table) => {
          if (table !== "heartbeats") pendingLight = false;
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => {
            const light = pendingLight;
            pendingLight = true;
            void refreshRef.current(true, light);
          }, 1000);
        })
      : undefined;
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(debounce);
      unsubscribe?.();
    };
  }, [authed]);

  useEffect(() => {
    if (!authed || !config || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let cancelled = false;
    // iOS drops subscriptions silently and pushsubscriptionchange is unreliable there, so every
    // app open re-checks the browser subscription and re-registers it with the backend.
    const reconcile = async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        if (!cancelled) setPushEnabled(false);
        return;
      }
      const existingKey = arrayBufferToUrlBase64(subscription.options.applicationServerKey);
      if (config.vapid_public_key && existingKey !== config.vapid_public_key) {
        await subscription.unsubscribe();
        if (!cancelled) {
          setPushEnabled(false);
          setNotice("The push security key changed. Tap Enable notifications to reconnect this device.");
        }
        return;
      }
      await backend.subscribe(subscription.toJSON());
      if (!cancelled) setPushEnabled(true);
    };
    reconcile().catch(() => {
      if (!cancelled) setPushEnabled(false);
    });
    return () => { cancelled = true; };
  }, [config, authed]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await backend.signIn({ token: tokenDraft, email: emailDraft, password: passwordDraft });
      setPasswordDraft("");
      setStatus(null);
      setAuthed(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  const loadAccess = useCallback(async () => {
    if (!backend.listAccess) return;
    try {
      setAccess(await backend.listAccess());
      setAccessError("");
    } catch (listError) {
      setAccessError(listError instanceof Error ? listError.message : String(listError));
    }
  }, []);

  useEffect(() => {
    if (!authed || !backend.isOwner) { setIsOwner(false); return; }
    let cancelled = false;
    void backend.isOwner()
      .then((owner) => { if (!cancelled) { setIsOwner(owner); if (owner) void loadAccess(); } })
      .catch(() => { if (!cancelled) setIsOwner(false); });
    return () => { cancelled = true; };
  }, [authed, loadAccess]);

  const issuePasscode = async (event: FormEvent) => {
    event.preventDefault();
    if (!backend.issuePasscode) return;
    setAccessError("");
    try {
      setIssuedCode(await backend.issuePasscode({
        label: codeLabel.trim() || "guest",
        expiresInDays: codeDays > 0 ? codeDays : null
      }));
      await loadAccess();
    } catch (issueError) {
      setAccessError(issueError instanceof Error ? issueError.message : String(issueError));
    }
  };

  const revoke = async (input: { codeId?: string; memberId?: string }) => {
    if (!backend.revokeAccess) return;
    setAccessError("");
    try {
      await backend.revokeAccess(input);
      await loadAccess();
    } catch (revokeError) {
      setAccessError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    }
  };

  const redeemPasscode = async (event: FormEvent) => {
    event.preventDefault();
    if (!backend.redeemPasscode) return;
    setLoading(true);
    setError("");
    try {
      await backend.redeemPasscode(passcodeDraft);
      setPasscodeDraft("");
      setStatus(null);
      setAuthed(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "That passcode is not valid.");
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    await backend.signOut();
    setAuthed(false);
    setStatus(null);
    setAlerts([]);
    setConfig(null);
    setTokenDraft("");
  };

  const enableNotifications = async () => {
    if (!authed || !config) {
      setError("Sign in first.");
      return;
    }
    if (!config.vapid_public_key) {
      setError("The push public key is not configured for this deployment (VAPID_PUBLIC_KEY).");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setError("This browser does not support Web Push. On iPhone, install the app to the Home Screen first.");
      return;
    }
    setLoading(true);
    setNotice("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        if (config.line_configured) {
          setNotice("Browser push skipped. LINE alerts are active and delivering all signals directly to your phone!");
          return;
        }
        throw new Error("Notification permission was not granted.");
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && arrayBufferToUrlBase64(subscription.options.applicationServerKey) !== config.vapid_public_key) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key) as BufferSource
        });
      }
      await backend.subscribe(subscription.toJSON());
      setPushEnabled(true);
      setNotice("Notifications are enabled on this device.");
      await refresh(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not enable notifications");
    } finally {
      setLoading(false);
    }
  };

  const disableNotifications = async () => {
    setLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await backend.unsubscribe(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setPushEnabled(false);
      setNotice("Notifications disabled on this device.");
      await refresh(true);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  };

  const sendTest = async () => {
    setLoading(true);
    try {
      const result = await backend.testPush();
      if (!result.subscriptions) throw new Error("No device is subscribed yet.");
      setNotice(`Test accepted for ${result.accepted} device${result.accepted === 1 ? "" : "s"}${result.failed ? `, ${result.failed} failed` : ""}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Test failed");
    } finally {
      setLoading(false);
    }
  };

  const sendLineTest = async () => {
    if (!backend.testLine) return;
    setLoading(true);
    try {
      const result = await backend.testLine();
      setNotice(result.message || "LINE test notification delivered!");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "LINE test failed");
    } finally {
      setLoading(false);
    }
  };

  const install = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setStandalone(true);
      setInstallPrompt(null);
      return;
    }
    setNotice("On iPhone/iPad: Share → Add to Home Screen. On desktop: use Install in the browser address bar.");
  };

  const cards = useMemo(
    () => Object.values(status?.watcher.timeframes || {}).sort((a, b) => a.timeframe_minutes - b.timeframe_minutes),
    [status]
  );

  /**
   * The instruments a pane can show, each with the timeframes that instrument actually has.
   * Splitting the old combined dropdown in two turns an N x M list into two short ones, and lets
   * somebody compare one symbol across timeframes without hunting through combinations.
   */
  const paneSymbols = useMemo<PaneSymbol[]>(() => {
    const setSymbols = [...new Set(setTickers.map((row) => row.symbol))];
    // Looking at a chart is not the same as being alerted on it, so every instrument offers every
    // supported timeframe regardless of what is on anybody's watchlist. A timeframe with nothing
    // stored yet is fetched on demand when the pane asks for it.
    const allFrames = WATCH_TIMEFRAMES.map((frame) => frame.minutes);
    // The local backend has only what the laptop watcher itself publishes.
    const goldFrames = backend.kind === "supabase"
      ? allFrames
      : (config?.timeframes?.length ? config.timeframes : GOLD_TIMEFRAMES)
          .filter((frame) => SUPPORTED_TIMEFRAMES.has(frame))
          .sort((a, b) => a - b);
    const watchedSymbols = [...new Set(watchlist.map((entry) => entry.symbol))];
    return [
      { key: "gold", label: goldSymbol, timeframes: goldFrames },
      ...(backend.kind === "supabase"
        ? [{ key: "btc", label: "BTCUSDT", timeframes: allFrames }]
        : []),
      ...setSymbols.map((symbol) => ({
        key: `set:${symbol}`,
        label: `${shortSymbol(symbol)} · delayed`,
        timeframes: allFrames
      })),
      ...watchedSymbols.map((symbol) => ({
        key: `watch:${symbol}`,
        label: shortSymbol(symbol) + (isDelayedSymbol(symbol) ? " · delayed" : ""),
        timeframes: allFrames
      }))
    ];
  }, [setTickers, goldSymbol, config, watchlist]);

  const setPane = useCallback((index: number, paneKey: string) => {
    setPanes((previous) => {
      const next = [...previous];
      while (next.length < 4) next.push("gold:10");
      next[index] = paneKey;
      return next;
    });
  }, []);

  const showWatchInstrument = useCallback((symbol: string, timeframe: number) => {
    setPane(0, watchPaneKey(symbol, timeframe));
    chartPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [setPane]);

  // Four charts at once need less height each than one. In fullscreen the CSS takes over and
  // the chart resizes itself to the cell, so this is only the starting size.
  const paneHeight = layout === 1 ? 560 : layout === 2 ? 420 : 340;

  const renderPane = (paneKey: string) => {
    const instrument = chartInstrument(paneKey, goldSymbol);
    if (!instrument || (backend.kind === "legacy" && instrument.kind !== "gold")) {
      return (
        <div className="empty-state compact">
          <strong>{t("This chart is not available on the local backend")}</strong>
          <p>{t("Choose a gold timeframe, or open the Supabase deployment for SET and Bitcoin.")}</p>
        </div>
      );
    }
    const series = candleSeries[candleSeriesKey(instrument.symbol, instrument.timeframe)];
    if (!series?.candles.length) {
      const name = instrument.kind === "bitcoin" ? "Bitcoin" : shortSymbol(instrument.symbol);
      const detail = instrument.kind === "set"
        ? "Closed SET candles arrive from the 15-minute-delayed feed."
        : instrument.kind === "bitcoin"
          ? "The cloud candle scanner has not stored this Bitcoin timeframe yet."
          : instrument.kind === "watch"
            ? "The watchlist scanner fills this chart on its next run, within one candle."
            : backend.kind === "supabase"
              ? "Gold candles appear after the laptop watcher or cloud failover publishes them."
              : "Candles appear after the first evaluated MT5 bar.";
      if (fetchingCandles) {
        return (
          <div className="empty-state compact">
            <strong>{t("Fetching")} {name} {timeframeLabel(instrument.timeframe)}…</strong>
            <p>{t("This timeframe has not been stored yet. It is being fetched now.")}</p>
          </div>
        );
      }
      return (
        <div className="empty-state compact">
          <strong>No {name} candles yet for {timeframeLabel(instrument.timeframe)}</strong>
          <p>{detail}</p>
        </div>
      );
    }
    const forming = instrument.kind === "gold" && status?.watcher.connected
      ? status?.watcher.timeframes[String(instrument.timeframe)]?.forming || series.forming
      : null;
    const delayed = instrument.kind === "set" || (instrument.kind === "watch" && isDelayedSymbol(instrument.symbol));
    return (
      <CandleChart
        candles={series.candles}
        alerts={alerts}
        symbol={instrument.symbol}
        timeframe={instrument.timeframe}
        forming={forming}
        priceStatus={delayed ? "delayed" : "closed"}
        height={paneHeight}
        indicators={indicators}
      />
    );
  };
  const apiReachable = Boolean(status && lastSuccessAt && clock - lastSuccessAt < (backend.onChange ? 90_000 : 12_000));
  const connected = Boolean(apiReachable && status?.watcher.connected);
  const feedFresh = cards.some((card) => card.feed_fresh);
  const cloud = status?.cloud;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><span /></div>
        <div className="brand-copy">
          <span>{t("Aurum Signal")}</span>
          <small>{t("Confirmed MACD watcher")}</small>
        </div>
        <div className={`connection-pill ${connected && feedFresh ? "connected" : ""}`}>
          <StatusDot live={connected && feedFresh} /> {connected ? (feedFresh ? t("Live") : t("Market paused")) : t("Offline")}
        </div>
        <div className="lang-toggle" role="group" aria-label="Language">
          {(["en", "th"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={option === lang ? "active" : ""}
              aria-pressed={option === lang}
              onClick={() => setLang(option)}
            >
              {option === "en" ? "EN" : "ไทย"}
            </button>
          ))}
        </div>
      </header>

      {authed === false && (
        <section className="onboarding panel">
          <span className="eyebrow">{t("Private access")}</span>
          <h1>{t("Connect your watcher")}</h1>
          {backend.kind === "supabase" ? (
            <>
              <p>{t("Sign in with the watcher account created in Supabase Auth.")}</p>
              <form onSubmit={signIn}>
                <input
                  type="email"
                  autoComplete="username"
                  value={emailDraft}
                  onChange={(event) => setEmailDraft(event.target.value)}
                  placeholder={t("Email")}
                  required
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordDraft}
                  onChange={(event) => setPasswordDraft(event.target.value)}
                  placeholder={t("Password")}
                  required
                />
                <button className="primary" type="submit" disabled={loading}>{loading ? t("Signing in…") : t("Sign in")}</button>
              </form>
              {backend.redeemPasscode && (
                <>
                  <p className="passcode-divider">{t("Or enter a passcode the owner gave you.")}</p>
                  <form onSubmit={redeemPasscode}>
                    <input
                      autoComplete="one-time-code"
                      spellCheck={false}
                      value={passcodeDraft}
                      onChange={(event) => setPasscodeDraft(event.target.value.toUpperCase())}
                      placeholder="XXXX-XXXX-XXXX"
                      aria-label={t("Passcode")}
                      required
                    />
                    <button className="ghost" type="submit" disabled={loading}>{loading ? t("Checking…") : t("Use passcode")}</button>
                  </form>
                </>
              )}
            </>
          ) : (
            <>
              <p>{t("Enter the same")}<code>APP_TOKEN</code> stored in the PC’s <code>.env</code> file.</p>
              <form onSubmit={signIn}>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder={t("App token")}
                  required
                />
                <button className="primary" type="submit" disabled={loading}>{t("Connect")}</button>
              </form>
            </>
          )}
          {error && <div className="message error"><span>{error}</span></div>}
          <button
            className="ghost onboarding-share"
            type="button"
            aria-haspopup="dialog"
            aria-controls="share-app-dialog"
            aria-expanded={shareOpen}
            onClick={() => setShareOpen(true)}
          >{t("Open on phone (QR)")}</button>
        </section>
      )}

      {authed && (
        <>
          <section className="hero">
            <div>
              <span className="eyebrow">{goldSymbol} · MT5</span>
              <h1>{t("Watching the close.")}</h1>
              <p>{t("Alerts fire only after a candle is complete, so the signal does not repaint.")}</p>
            </div>
            <div className="hero-stat">
              <span>{t("Polling")}</span>
              <strong>{config ? `${config.poll_interval_ms} ms` : "—"}</strong>
              <small>{backend.kind === "supabase" ? "Cloud fan-out via Supabase" : "React adds no watcher delay"}</small>
            </div>
          </section>

          {(error || notice) && (
            <div className={`message ${error ? "error" : "success"}`}>
              <span>{error || notice}</span>
              <button onClick={() => { setError(""); setNotice(""); }} aria-label={t("Dismiss")}>×</button>
            </div>
          )}

          <section className="action-strip panel">
            <div className="action-copy">
              <div className="bell"><BellIcon /></div>
              <div>
                <strong>{config?.line_configured ? (pushEnabled ? "LINE & Browser Push Active" : "LINE Alerts Active 🟢") : (pushEnabled ? "Push is armed" : "Enable alerts on this device")}</strong>
                <span>
                  {config?.line_configured
                    ? `Instant alerts sent to your LINE account${pushEnabled ? ` · ${status?.subscriptions || 0} browser device(s)` : ""}`
                    : `${status?.subscriptions || 0} connected device${status?.subscriptions === 1 ? "" : "s"}`}
                </span>
              </div>
            </div>
            <div className="button-row">
              {/* LINE has one recipient, the owner's own account, so a guest pressing Test LINE
                  would message the owner's phone rather than their own. Owner only. */}
              {config?.line_configured && isOwner && (
                <>
                  <button
                    className="primary"
                    type="button"
                    style={{ background: "#06c755", borderColor: "#06c755", color: "#fff", fontWeight: 600 }}
                    onClick={() => setLineModalOpen(true)}
                  >
                    + Add LINE Bot
                  </button>
                  <button className="ghost" disabled={loading} onClick={sendLineTest} title={t("Test LINE Messaging API notification")}>
                    {loading ? t("Testing…") : t("Test LINE")}
                  </button>
                </>
              )}
              <button
                className="ghost"
                type="button"
                aria-haspopup="dialog"
                aria-controls="share-app-dialog"
                aria-expanded={shareOpen}
                onClick={() => setShareOpen(true)}
              >{t("Phone QR")}</button>
              {!standalone && <button className="ghost" onClick={install}>{t("Install app")}</button>}
              {pushEnabled ? (
                <>
                  <button className="ghost" disabled={loading} onClick={sendTest}>{t("Browser test")}</button>
                  <button className="quiet" disabled={loading} onClick={disableNotifications}>{t("Mute web")}</button>
                </>
              ) : (
                <button className={config?.line_configured ? "ghost" : "primary"} disabled={loading} onClick={enableNotifications} title={t("Optional: receive browser notifications on this PC")}>
                  {loading ? t("Connecting…") : (config?.line_configured ? `+ ${t("Browser push")}` : t("Enable notifications"))}
                </button>
              )}
            </div>
          </section>

          {isOwner && (
            <>
              <div className="section-title">
                <div><span className="eyebrow">{t("Access")}</span><h2>{t("Passcodes")}</h2></div>
              </div>
              <section className="panel diagnostics">
                {accessError && <div className="message error"><span>{accessError}</span></div>}
                <p className="chart-legend-note" style={{ marginLeft: 0 }}>
                  Each passcode works once, on one device. Whoever redeems it first keeps it, and the
                  same code offered anywhere else is refused. Guests can watch the signals and enrol
                  their own device; only this account can change settings or issue codes.
                </p>
                <form onSubmit={issuePasscode} className="access-row">
                  <input className="grow" value={codeLabel} onChange={(e) => setCodeLabel(e.target.value)} placeholder={t("Who is it for?")} aria-label={t("Passcode label")} />
                  <label className="field-inline">{t("Expires in")}<input type="number" min={0} max={365} value={codeDays} onChange={(e) => setCodeDays(Number(e.target.value))} style={{ width: 64 }} />
                    days{codeDays === 0 ? " (never)" : ""}
                  </label>
                  <button className="primary" type="submit">{t("Generate")}</button>
                </form>
                {issuedCode && (
                  <>
                    <code className="issued-code">{issuedCode}</code>
                    <p className="chart-legend-note" style={{ marginLeft: 0 }}>{t("Copy it now. Only its hash is stored, so it cannot be shown again.")}</p>
                  </>
                )}
                {access.codes.map((code) => {
                  const spent = code.uses >= code.max_uses;
                  const expired = Boolean(code.expires_at && Date.parse(code.expires_at) < clock);
                  const dead = Boolean(code.revoked_at) || spent || expired;
                  return (
                    <div className="access-row" key={code.id}>
                      <span className="grow">{code.label}</span>
                      <span className="muted">{code.claimed_at ? `${t("claimed")} ${formatTime(code.claimed_at, false)}` : t("unclaimed")}</span>
                      <span className="muted">
                        {code.revoked_at ? t("cancelled") : expired ? t("expired") : spent ? t("used up") : code.expires_at ? `${t("until")} ${formatTime(code.expires_at, false)}` : t("no expiry")}
                      </span>
                      {!dead && <button className="ghost" onClick={() => void revoke({ codeId: code.id })}>{t("Revoke")}</button>}
                    </div>
                  );
                })}
                {access.members.filter((member) => !member.is_owner).map((member) => (
                  <div className="access-row" key={member.user_id}>
                    <span className="grow">{member.label}</span>
                    <span className="muted">{t("joined")} {formatTime(member.granted_at, false)}</span>
                    <span className="muted">{member.revoked_at ? t("revoked") : t("active")}</span>
                    {!member.revoked_at && <button className="ghost" onClick={() => void revoke({ memberId: member.user_id })}>{t("Remove")}</button>}
                  </div>
                ))}
              </section>
            </>
          )}

          {cloud && (
          <section className="diagnostics panel">
              <div>
                <span className="eyebrow">{t("Cloud health")}</span>
                <h2>{t("Heartbeats")}</h2>
              </div>
              <div className="diagnostic-metrics">
                <div><span>{t("Laptop watcher")}</span><strong>{formatAgo(cloud.gold_last_seen, clock)}</strong></div>
                {cloud.gold_cloud_last_seen && (
                  <div><span>{t("Cloud failover")}</span><strong>{formatAgo(cloud.gold_cloud_last_seen, clock)}</strong></div>
                )}
                <div><span>{t("SET scanner")}</span><strong>{formatAgo(cloud.set_last_seen, clock)}</strong></div>
                {cloud.tv_webhook_last_seen && (
                  <div><span>{t("TradingView alert")}</span><strong>{formatAgo(cloud.tv_webhook_last_seen, clock)}</strong></div>
                )}
                <div><span>{t("Push fan-out")}</span><strong>{formatAgo(cloud.push_last_seen, clock)}</strong></div>
              </div>
              <p>
                {cloud.set_update_mode ? `SET feed: ${cloud.set_update_mode}` : "SET scanner has not run yet"}
                {cloud.set_dry_run ? " · dry run (no SET pushes)" : ""}
                {status?.watcher.last_offline_gap_s ? ` · laptop was offline ${Math.round(status.watcher.last_offline_gap_s / 60)} min at ${formatTime(status.watcher.last_offline_gap_at)}` : ""}
              </p>
            </section>
          )}

          <div className="section-title">
            <div><span className="eyebrow">{t("Chart")}</span><h2>MACD 12 / 26 / 9 · RSI 14</h2></div>
            <div className="chart-controls">
              <div className="tabs" role="group" aria-label={t("Chart layout")}>
                {[1, 2, 4].map((count) => (
                  <button
                    key={count}
                    className={count === layout ? "active" : ""}
                    aria-pressed={count === layout}
                    onClick={() => setLayout(count)}
                  >
                    {count} up
                  </button>
                ))}
              </div>
              <button className="ghost" onClick={toggleExpanded}>{expanded ? t("Exit full screen") : t("Full screen")}</button>
            </div>
          </div>
          <section className={`panel chart-panel${expanded ? " expanded" : ""}`} ref={chartPanel}>
            {chartError && <div className="message error"><span>Chart data: {chartError}</span></div>}
            {expanded && (
              <button className="ghost expanded-close" onClick={toggleExpanded} aria-label={t("Exit full screen")}>{t("Close")}</button>
            )}
            <div className="indicator-picker" role="group" aria-label={t("Indicators")}>
              {INDICATORS.map((indicator) => {
                const on = indicators.includes(indicator.key);
                return (
                  <button
                    key={indicator.key}
                    type="button"
                    className={on ? "chip on" : "chip"}
                    aria-pressed={on}
                    onClick={() => setIndicators((previous) => orderIndicators(
                      previous.includes(indicator.key)
                        ? previous.filter((key) => key !== indicator.key)
                        : [...previous, indicator.key]
                    ))}
                  >
                    {indicator.label}
                  </button>
                );
              })}
            </div>
            <div className="chart-grid" data-panes={layout}>
              {visiblePanes.map((paneKey, index) => (
                <div className="chart-cell" key={`${index}:${paneKey}`}>
                  <div className="chart-cell-head">
                    {(() => {
                      const symbolKey = paneSymbolKey(paneKey);
                      const chosen = paneSymbols.find((candidate) => candidate.key === symbolKey);
                      const current = chartInstrument(paneKey, goldSymbol);
                      // A pane saved against something that has since left the watchlist keeps
                      // its own entry, so neither dropdown ever renders blank.
                      const symbols = chosen
                        ? paneSymbols
                        : [{ key: symbolKey, label: chartInstrumentLabel(paneKey, goldSymbol), timeframes: [] }, ...paneSymbols];
                      const frames = chosen?.timeframes.length
                        ? chosen.timeframes
                        : current ? [current.timeframe] : [];
                      return (
                        <>
                          <select
                            value={symbolKey}
                            aria-label={`Chart ${index + 1} instrument`}
                            onChange={(event) => {
                              const nextSymbol = event.target.value;
                              const available = paneSymbols.find((candidate) => candidate.key === nextSymbol)?.timeframes ?? [];
                              // Hold the timeframe across a symbol change when the new instrument
                              // has it, so comparing two symbols on H1 takes one click, not two.
                              const keep = current && available.includes(current.timeframe)
                                ? current.timeframe
                                : available[0] ?? 15;
                              setPane(index, composePaneKey(nextSymbol, keep));
                            }}
                          >
                            {symbols.map((option) => (
                              <option key={option.key} value={option.key}>{option.label}</option>
                            ))}
                          </select>
                          <select
                            value={String(current?.timeframe ?? frames[0] ?? 15)}
                            aria-label={`Chart ${index + 1} timeframe`}
                            disabled={frames.length < 2}
                            title={frames.length < 2 ? t("Only one timeframe is published for this instrument.") : undefined}
                            onChange={(event) => setPane(index, composePaneKey(symbolKey, Number(event.target.value)))}
                          >
                            {frames.map((frame) => (
                              <option key={frame} value={frame}>{timeframeLabel(frame)}</option>
                            ))}
                          </select>
                        </>
                      );
                    })()}
                  </div>
                  {renderPane(paneKey)}
                </div>
              ))}
            </div>
          </section>

          {backend.kind === "supabase" && (
            <>
              <div className="section-title">
                <div>
                  <span className="eyebrow">{t("Your instruments · M5 to D1 · no setup needed")}</span>
                  <h2>{t("Watchlist")}</h2>
                </div>
              </div>
              <WatchlistPanel
                entries={watchlist}
                error={watchError}
                // The owner's LINE destination is the function's own secret; a guest has one only
                // if it has been recorded for them, so the chip is not offered blindly.
                lineAvailable={Boolean(config?.line_configured) && (isOwner || Boolean(notificationPrefs?.line_connected))}
                onChanged={() => void loadWatchlist()}
                onSelect={showWatchInstrument}
              />
              <QuietHoursPanel prefs={notificationPrefs} onSaved={setNotificationPrefs} />

              <div className="section-title">
                <div><span className="eyebrow">{t("SET stocks · 15m · TradingView (15-min delayed)")}</span><h2>{t("MACD by ticker")}</h2></div>
              </div>
              <section className="panel">
                {setPanelError && <div className="message error"><span>SET data: {setPanelError}</span></div>}
                <table className="set-table">
                  <thead>
                    <tr><th>{t("Ticker")}</th><th>MACD</th><th>{t("Signal")}</th><th>{t("Hist")}</th><th>{t("Last closed bar")}</th><th>{t("Feed")}</th></tr>
                  </thead>
                  <tbody>
                    {setTickers.length === 0 ? (
                      <tr><td className="empty-cell" colSpan={6}>{setPanelError ? "Could not load SET data." : "No SET tickers are configured yet."}</td></tr>
                    ) : setTickers.map((row) => (
                      <tr
                        key={row.symbol}
                        className={`selectable${row.symbol === selectedSet ? " selected" : ""}`}
                        onClick={() => setSelectedSet(row.symbol)}
                      >
                        <td>{shortSymbol(row.symbol)}</td>
                        <td>{row.macd?.toFixed(4) ?? "—"}</td>
                        <td>{row.signal?.toFixed(4) ?? "—"}</td>
                        <td className={(row.histogram ?? 0) >= 0 ? "mint" : "coral"}>{row.histogram?.toFixed(4) ?? "—"}</td>
                        <td>{formatTime(row.last_bar_time, false)}</td>
                        <td>{row.last_error ? "error" : row.update_mode === "delayed_streaming_900" ? "delayed 15m" : row.update_mode || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedSet && (
                  <div className="set-detail-chart">
                    <div className="set-detail-heading">
                      <strong>{shortSymbol(selectedSet)} · M15 candlesticks</strong>
                      <span>{t("Closed bars · TradingView, delayed 15 minutes")}</span>
                    </div>
                    {candleSeries[candleSeriesKey(selectedSet, 15)]?.candles.length ? (
                      <CandleChart
                        candles={candleSeries[candleSeriesKey(selectedSet, 15)].candles}
                        alerts={alerts}
                        symbol={selectedSet}
                        timeframe={15}
                        priceStatus="delayed"
                        height={360}
                      />
                    ) : (
                      <div className="empty-state compact">
                        <strong>No stored candlesticks for {shortSymbol(selectedSet)} yet</strong>
                        <p>{t("The cloud scanner will populate this chart with closed, delayed M15 bars.")}</p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          <section className="diagnostics panel">
            <div>
              <span className="eyebrow">{t("Measured delivery")}</span>
              <h2>{t("Latency diagnostics")}</h2>
            </div>
            <div className="diagnostic-metrics">
              <div><span>{t("Median")}</span><strong>{formatLatency(status?.latency.p50_ms)}</strong></div>
              <div><span>{t("95th percentile")}</span><strong>{formatLatency(status?.latency.p95_ms)}</strong></div>
              <div><span>{t("Samples")}</span><strong>{status?.latency.samples ?? 0}</strong></div>
            </div>
            <p>{t("Measured from the scheduled candle close to receipt by the device service worker.")}</p>
          </section>

          <div className="section-title history-heading">
            <div><span className="eyebrow">{t("Audit trail")}</span><h2>{t("Alert history")}</h2></div>
          </div>
          <section className="history panel">
            {alerts.length === 0 ? (
              <div className="empty-state">
                <span className="empty-ring" />
                <strong>{t("No confirmed crossovers yet")}</strong>
                <p>Watching {(status?.watcher.directions || ["bullish", "bearish"]).join(" and ")} crosses. The watcher seeds the current candle on first start and will not send an old signal.</p>
              </div>
            ) : alerts.map((alert) => (
              <article className={`alert-row${highlightedAlert === alert.id ? " highlighted" : ""}`} key={alert.id}>
                <div className="alert-symbol">{alert.direction === "info" ? "SYS" : timeframeLabel(alert.timeframe_minutes)}</div>
                <div className="alert-main">
                  <strong className={alert.direction === "bearish" ? "coral" : alert.direction === "bullish" ? "mint" : undefined}>
                    {alertHeadline(alert)}
                  </strong>
                  <span>
                    {alert.direction === "info"
                      ? `${formatTime(alert.detected_at, true)} · ${alert.body || ""}`
                      : `${formatTime(alert.bar_close, true)} · ${alert.price.toFixed(2)}`}
                  </span>
                </div>
                <div className="alert-delivery">
                  <strong>+{formatLatency(alert.detection_delay_ms)}</strong>
                  <span>{alert.device_received ? "Received" : alert.push_accepted ? "Push accepted" : "Logged"}</span>
                </div>
              </article>
            ))}
          </section>

          <footer>
            <span>Alert-only · No trading permissions · {backend.kind === "supabase" ? "Supabase" : "Local"} backend · build {__APP_VERSION__}</span>
            <button onClick={signOut}>{backend.kind === "supabase" ? t("Sign out") : t("Change token")}</button>
          </footer>
        </>
      )}
      <ShareAppDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      <LineBotDialog
        open={lineModalOpen}
        onClose={() => setLineModalOpen(false)}
        config={config}
        onSendTest={sendLineTest}
        loading={loading}
      />
    </main>
  );
}
