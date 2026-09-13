import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { AlertRecord, CandleSeries, PublicConfig, SetTickerState, StatusResponse, TimeframeState } from "./api";
import { createBackend } from "./backend";
import { CandleChart } from "./charts";

const backend = createBackend();
const BITCOIN_SYMBOL = "BINANCE:BTCUSDT";

type ChartInstrumentKind = "gold" | "set" | "bitcoin";

interface ChartInstrument {
  kind: ChartInstrumentKind;
  symbol: string;
  timeframe: number;
}

function candleSeriesKey(symbol: string, timeframe: number): string {
  return `${symbol}|${timeframe}`;
}

function chartInstrument(paneKey: string, goldSymbol: string): ChartInstrument | null {
  if (paneKey.startsWith("gold:")) {
    const timeframe = Number(paneKey.slice(5));
    return timeframe === 10 || timeframe === 15 ? { kind: "gold", symbol: goldSymbol, timeframe } : null;
  }
  if (paneKey.startsWith("btc:")) {
    const timeframe = Number(paneKey.slice(4));
    return timeframe === 10 || timeframe === 15 ? { kind: "bitcoin", symbol: BITCOIN_SYMBOL, timeframe } : null;
  }
  if (paneKey.startsWith("set:")) {
    const symbol = paneKey.slice(4);
    return symbol ? { kind: "set", symbol, timeframe: 15 } : null;
  }
  return null;
}

function chartInstrumentLabel(paneKey: string, goldSymbol: string): string {
  const instrument = chartInstrument(paneKey, goldSymbol);
  if (!instrument) return paneKey;
  if (instrument.kind === "gold") return `${goldSymbol} · M${instrument.timeframe}`;
  if (instrument.kind === "bitcoin") return `BTCUSDT · M${instrument.timeframe} · closed`;
  return `${instrument.symbol.replace(/^SET:/, "")} · M15 · delayed`;
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

function TimeframeCard({ value }: { value: TimeframeState }) {
  const positive = value.histogram > 0;
  return (
    <article className="timeframe-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Confirmed candle</span>
          <h2>M{value.timeframe_minutes}</h2>
        </div>
        <span className={`trend-chip ${positive ? "positive" : "negative"}`}>
          {positive ? "MACD above" : "MACD below"}
        </span>
      </div>
      <div className="price">{value.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      <div className="indicator-grid">
        <div><span>MACD</span><strong>{value.macd.toFixed(4)}</strong></div>
        <div><span>Signal</span><strong>{value.signal.toFixed(4)}</strong></div>
        <div><span>Histogram</span><strong className={positive ? "mint" : "coral"}>{value.histogram.toFixed(4)}</strong></div>
      </div>
      <div className="card-footer">
        <span>Closed {formatTime(value.bar_close, true)}{value.provisional ? " · by clock" : ""}</span>
        <span>{value.feed_fresh ? `Detected +${formatLatency(value.detection_delay_ms)}` : "Market paused"}</span>
      </div>
    </article>
  );
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
        <button className="share-close" type="button" onClick={onClose} aria-label="Close QR code" autoFocus>×</button>
        <span className="eyebrow">Open on another device</span>
        <h2 id="share-app-title">Scan to open Aurum Signal</h2>
        <p>The QR opens this web app. Then install it from your phone browser to give it its own Home Screen icon.</p>
        <div className="qr-frame">
          {qrDataUrl ? <img src={qrDataUrl} width="224" height="224" alt={`QR code for ${appUrl}`} /> : <span>Generating QR…</span>}
        </div>
        <code className="share-url">{appUrl}</code>
        {localOnly && <p className="share-warning">This preview points to this computer only. Deploy to Vercel first; the QR will automatically use the final Vercel address.</p>}
        <div className="share-actions">
          <button className="primary" type="button" onClick={shareOrCopy}>{canShare ? "Share link" : "Copy link"}</button>
          <button className="ghost" type="button" onClick={onClose}>Done</button>
        </div>
        <ol className="install-steps">
          <li><strong>Android:</strong> open in Chrome, then tap Install app or Add to Home screen.</li>
          <li><strong>iPhone/iPad:</strong> open in Safari, tap Share, then Add to Home Screen.</li>
          <li>Open the installed icon, sign in, and tap Enable notifications.</li>
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
        <button className="share-close" type="button" onClick={onClose} aria-label="Close" autoFocus>×</button>
        <span className="eyebrow" style={{ color: "#06c755" }}>LINE Messaging API</span>
        <h2 id="line-bot-title">Add Aurum Signal Bot</h2>
        <p>Scan this QR code with your phone or tap the button to add the bot on LINE.</p>
        <div className="qr-frame">
          {qrDataUrl ? <img src={qrDataUrl} width="224" height="224" alt="LINE Bot QR code" /> : <span>Generating QR…</span>}
        </div>
        {config?.line_bot_id && <code className="share-url">LINE Basic ID: {config.line_bot_id}</code>}
        <div className="share-actions">
          <a
            className="primary"
            href={addUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none", textAlign: "center", display: "inline-block", background: "#06c755", borderColor: "#06c755", color: "#fff" }}
          >
            Open in LINE
          </a>
          <button className="ghost" type="button" disabled={loading} onClick={onSendTest}>
            {loading ? "Sending…" : "Test LINE Alert"}
          </button>
        </div>
        <ol className="install-steps">
          <li>Scan the QR code with your LINE app or tap <strong>Open in LINE</strong>.</li>
          <li>Tap <strong>Add Friend</strong> to start receiving alerts.</li>
          <li>Tap <strong>Test LINE Alert</strong> above to verify notifications on your phone!</li>
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
      ? `${alert.symbol.replace(/^SET:/, "")} · `
      : "";
  return `${prefix}${alert.direction === "bearish" ? "▼ Bearish" : "▲ Bullish"} MACD crossover`;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
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
  const [candleSeries, setCandleSeries] = useState<Record<string, CandleSeries>>({});
  const [chartError, setChartError] = useState("");
  const [setTickers, setSetTickers] = useState<SetTickerState[]>([]);
  const [setPanelError, setSetPanelError] = useState("");
  const [selectedSet, setSelectedSet] = useState<string>("");
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

  const paneOptions = useMemo(() => {
    const setSymbols = [...new Set(setTickers.map((row) => row.symbol))];
    return [
      ...[10, 15].map((tf) => ({ value: `gold:${tf}`, label: `${goldSymbol} · M${tf}` })),
      ...(backend.kind === "supabase"
        ? [10, 15].map((tf) => ({ value: `btc:${tf}`, label: `BTCUSDT · M${tf} · closed` }))
        : []),
      ...setSymbols.map((symbol) => ({ value: `set:${symbol}`, label: `${symbol.replace(/^SET:/, "")} · M15 · delayed` }))
    ];
  }, [setTickers, goldSymbol]);

  // Four charts at once need less height each than one. In fullscreen the CSS takes over and
  // the chart resizes itself to the cell, so this is only the starting size.
  const paneHeight = layout === 1 ? 560 : layout === 2 ? 420 : 340;

  const renderPane = (paneKey: string) => {
    const instrument = chartInstrument(paneKey, goldSymbol);
    if (!instrument || (backend.kind === "legacy" && instrument.kind !== "gold")) {
      return (
        <div className="empty-state compact">
          <strong>This chart is not available on the local backend</strong>
          <p>Choose a gold timeframe, or open the Supabase deployment for SET and Bitcoin.</p>
        </div>
      );
    }
    const series = candleSeries[candleSeriesKey(instrument.symbol, instrument.timeframe)];
    if (!series?.candles.length) {
      const name = instrument.kind === "bitcoin" ? "Bitcoin" : instrument.symbol.replace(/^SET:/, "");
      const detail = instrument.kind === "set"
        ? "Closed SET candles arrive from the 15-minute-delayed feed."
        : instrument.kind === "bitcoin"
          ? "The cloud candle scanner has not stored this Bitcoin timeframe yet."
          : backend.kind === "supabase"
            ? "Gold candles appear after the laptop watcher or cloud failover publishes them."
            : "Candles appear after the first evaluated MT5 bar.";
      return (
        <div className="empty-state compact">
          <strong>No {name} candles yet for M{instrument.timeframe}</strong>
          <p>{detail}</p>
        </div>
      );
    }
    const forming = instrument.kind === "gold" && status?.watcher.connected
      ? status?.watcher.timeframes[String(instrument.timeframe)]?.forming || series.forming
      : null;
    return (
      <CandleChart
        candles={series.candles}
        alerts={alerts}
        symbol={instrument.symbol}
        timeframe={instrument.timeframe}
        forming={forming}
        priceStatus={instrument.kind === "set" ? "delayed" : "closed"}
        height={paneHeight}
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
          <span>Aurum Signal</span>
          <small>Confirmed MACD watcher</small>
        </div>
        <div className={`connection-pill ${connected && feedFresh ? "connected" : ""}`}>
          <StatusDot live={connected && feedFresh} /> {connected ? (feedFresh ? "Live" : "Market paused") : "Offline"}
        </div>
      </header>

      {authed === false && (
        <section className="onboarding panel">
          <span className="eyebrow">Private access</span>
          <h1>Connect your watcher</h1>
          {backend.kind === "supabase" ? (
            <>
              <p>Sign in with the watcher account created in Supabase Auth.</p>
              <form onSubmit={signIn}>
                <input
                  type="email"
                  autoComplete="username"
                  value={emailDraft}
                  onChange={(event) => setEmailDraft(event.target.value)}
                  placeholder="Email"
                  required
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordDraft}
                  onChange={(event) => setPasswordDraft(event.target.value)}
                  placeholder="Password"
                  required
                />
                <button className="primary" type="submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
              </form>
            </>
          ) : (
            <>
              <p>Enter the same <code>APP_TOKEN</code> stored in the PC’s <code>.env</code> file.</p>
              <form onSubmit={signIn}>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder="App token"
                  required
                />
                <button className="primary" type="submit" disabled={loading}>Connect</button>
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
          >
            Open on phone (QR)
          </button>
        </section>
      )}

      {authed && (
        <>
          <section className="hero">
            <div>
              <span className="eyebrow">{goldSymbol} · MT5</span>
              <h1>Watching the close.</h1>
              <p>Alerts fire only after a candle is complete, so the signal does not repaint.</p>
            </div>
            <div className="hero-stat">
              <span>Polling</span>
              <strong>{config ? `${config.poll_interval_ms} ms` : "—"}</strong>
              <small>{backend.kind === "supabase" ? "Cloud fan-out via Supabase" : "React adds no watcher delay"}</small>
            </div>
          </section>

          {(error || notice) && (
            <div className={`message ${error ? "error" : "success"}`}>
              <span>{error || notice}</span>
              <button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss">×</button>
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
              {config?.line_configured && (
                <>
                  <button
                    className="primary"
                    type="button"
                    style={{ background: "#06c755", borderColor: "#06c755", color: "#fff", fontWeight: 600 }}
                    onClick={() => setLineModalOpen(true)}
                  >
                    + Add LINE Bot
                  </button>
                  <button className="ghost" disabled={loading} onClick={sendLineTest} title="Test LINE Messaging API notification">
                    {loading ? "Testing…" : "Test LINE"}
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
              >
                Phone QR
              </button>
              {!standalone && <button className="ghost" onClick={install}>Install app</button>}
              {pushEnabled ? (
                <>
                  <button className="ghost" disabled={loading} onClick={sendTest}>Browser test</button>
                  <button className="quiet" disabled={loading} onClick={disableNotifications}>Mute web</button>
                </>
              ) : (
                <button className={config?.line_configured ? "ghost" : "primary"} disabled={loading} onClick={enableNotifications} title="Optional: receive browser notifications on this PC">
                  {loading ? "Connecting…" : (config?.line_configured ? "+ Browser push" : "Enable notifications")}
                </button>
              )}
            </div>
          </section>

          {cloud && (
            <section className="diagnostics panel">
              <div>
                <span className="eyebrow">Cloud health</span>
                <h2>Heartbeats</h2>
              </div>
              <div className="diagnostic-metrics">
                <div><span>Laptop watcher</span><strong>{formatAgo(cloud.gold_last_seen, clock)}</strong></div>
                {cloud.gold_cloud_last_seen && (
                  <div><span>Cloud failover</span><strong>{formatAgo(cloud.gold_cloud_last_seen, clock)}</strong></div>
                )}
                <div><span>SET scanner</span><strong>{formatAgo(cloud.set_last_seen, clock)}</strong></div>
                {cloud.tv_webhook_last_seen && (
                  <div><span>TradingView alert</span><strong>{formatAgo(cloud.tv_webhook_last_seen, clock)}</strong></div>
                )}
                <div><span>Push fan-out</span><strong>{formatAgo(cloud.push_last_seen, clock)}</strong></div>
              </div>
              <p>
                {cloud.set_update_mode ? `SET feed: ${cloud.set_update_mode}` : "SET scanner has not run yet"}
                {cloud.set_dry_run ? " · dry run (no SET pushes)" : ""}
                {status?.watcher.last_offline_gap_s ? ` · laptop was offline ${Math.round(status.watcher.last_offline_gap_s / 60)} min at ${formatTime(status.watcher.last_offline_gap_at)}` : ""}
              </p>
            </section>
          )}

          <div className="section-title">
            <div><span className="eyebrow">Live indicators</span><h2>Closed candles</h2></div>
            <span className="last-sync">Updated {formatTime(status?.watcher.last_poll_at, true)}</span>
          </div>
          <section className="card-grid">
            {cards.length ? cards.map((card) => <TimeframeCard key={card.timeframe_minutes} value={card} />) : (
              <div className="empty panel">Waiting for the first MT5 candle snapshot…</div>
            )}
          </section>

          <div className="section-title">
            <div><span className="eyebrow">Chart</span><h2>MACD 12 / 26 / 9 · RSI 14</h2></div>
            <div className="chart-controls">
              <div className="tabs" role="group" aria-label="Chart layout">
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
              <button className="ghost" onClick={toggleExpanded}>{expanded ? "Exit full screen" : "Full screen"}</button>
            </div>
          </div>
          <section className={`panel chart-panel${expanded ? " expanded" : ""}`} ref={chartPanel}>
            {chartError && <div className="message error"><span>Chart data: {chartError}</span></div>}
            {expanded && (
              <button className="ghost expanded-close" onClick={toggleExpanded} aria-label="Exit full screen">Close</button>
            )}
            <div className="chart-grid" data-panes={layout}>
              {visiblePanes.map((paneKey, index) => (
                <div className="chart-cell" key={`${index}:${paneKey}`}>
                  <div className="chart-cell-head">
                    <select
                      value={paneKey}
                      aria-label={`Chart ${index + 1} instrument`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setPanes((previous) => {
                          const next = [...previous];
                          while (next.length < 4) next.push("gold:10");
                          next[index] = value;
                          return next;
                        });
                      }}
                    >
                      {/* A pane saved against a ticker that has since left set_tickers keeps its
                          own entry, so the dropdown never renders blank. */}
                      {(paneOptions.some((option) => option.value === paneKey)
                        ? paneOptions
                        : [{ value: paneKey, label: chartInstrumentLabel(paneKey, goldSymbol) }, ...paneOptions]
                      ).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  {renderPane(paneKey)}
                </div>
              ))}
            </div>
          </section>

          {backend.kind === "supabase" && (
            <>
              <div className="section-title">
                <div><span className="eyebrow">SET stocks · 15m · TradingView (15-min delayed)</span><h2>MACD by ticker</h2></div>
              </div>
              <section className="panel">
                {setPanelError && <div className="message error"><span>SET data: {setPanelError}</span></div>}
                <table className="set-table">
                  <thead>
                    <tr><th>Ticker</th><th>MACD</th><th>Signal</th><th>Hist</th><th>Last closed bar</th><th>Feed</th></tr>
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
                        <td>{row.symbol.replace(/^SET:/, "")}</td>
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
                      <strong>{selectedSet.replace(/^SET:/, "")} · M15 candlesticks</strong>
                      <span>Closed bars · TradingView, delayed 15 minutes</span>
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
                        <strong>No stored candlesticks for {selectedSet.replace(/^SET:/, "")} yet</strong>
                        <p>The cloud scanner will populate this chart with closed, delayed M15 bars.</p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          <section className="diagnostics panel">
            <div>
              <span className="eyebrow">Measured delivery</span>
              <h2>Latency diagnostics</h2>
            </div>
            <div className="diagnostic-metrics">
              <div><span>Median</span><strong>{formatLatency(status?.latency.p50_ms)}</strong></div>
              <div><span>95th percentile</span><strong>{formatLatency(status?.latency.p95_ms)}</strong></div>
              <div><span>Samples</span><strong>{status?.latency.samples ?? 0}</strong></div>
            </div>
            <p>Measured from the scheduled candle close to receipt by the device service worker.</p>
          </section>

          <div className="section-title history-heading">
            <div><span className="eyebrow">Audit trail</span><h2>Alert history</h2></div>
          </div>
          <section className="history panel">
            {alerts.length === 0 ? (
              <div className="empty-state">
                <span className="empty-ring" />
                <strong>No confirmed crossovers yet</strong>
                <p>Watching {(status?.watcher.directions || ["bullish", "bearish"]).join(" and ")} crosses. The watcher seeds the current candle on first start and will not send an old signal.</p>
              </div>
            ) : alerts.map((alert) => (
              <article className={`alert-row${highlightedAlert === alert.id ? " highlighted" : ""}`} key={alert.id}>
                <div className="alert-symbol">{alert.direction === "info" ? "SYS" : `M${alert.timeframe_minutes}`}</div>
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
            <button onClick={signOut}>{backend.kind === "supabase" ? "Sign out" : "Change token"}</button>
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
