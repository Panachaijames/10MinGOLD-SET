import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { AlertRecord, CandleSeries, PublicConfig, SetMacdPoint, SetTickerState, StatusResponse, TimeframeState } from "./api";
import { createBackend } from "./backend";
import { CandleChart, MacdChart } from "./charts";

const backend = createBackend();

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
    (config?.line_bot_id ? `https://line.me/R/ti/p/@${config.line_bot_id.replace(/^@/, "")}` : "https://line.me/R/nv/recommendOA");
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
  const symbol = alert.source && alert.source !== "gold_mt5" ? `${alert.symbol.replace(/^SET:/, "")} · ` : "";
  return `${symbol}${alert.direction === "bearish" ? "▼ Bearish" : "▲ Bullish"} MACD crossover`;
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
  const [timeframe, setTimeframe] = useState<number>(() => Number(localStorage.getItem("aurum-timeframe")) || 10);
  const [candlesByTf, setCandlesByTf] = useState<Record<number, CandleSeries>>({});
  const [chartError, setChartError] = useState("");
  const [setTickers, setSetTickers] = useState<SetTickerState[]>([]);
  const [setPanelError, setSetPanelError] = useState("");
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [setHistory, setSetHistory] = useState<SetMacdPoint[]>([]);
  const highlightedAlert = useMemo(() => new URLSearchParams(window.location.search).get("alert"), []);
  const refreshing = useRef(false);
  const candleKey = useRef<Record<number, string>>({});

  const refresh = useCallback(async (quiet = false) => {
    if (!authed || refreshing.current) return;
    refreshing.current = true;
    try {
      const [nextStatus, nextAlerts] = await Promise.all([backend.status(), backend.alerts()]);
      setStatus(nextStatus);
      setAlerts(nextAlerts);
      setLastSuccessAt(Date.now());
      setError("");

      // Candles change only on a bar transition: re-download the series only when the active
      // timeframe's latest closed bar (or its provisional flag) differs from what we have.
      const card = nextStatus.watcher.timeframes[String(timeframe)];
      const key = card ? `${card.bar_open}|${card.provisional ? "p" : "f"}` : "none";
      if (candleKey.current[timeframe] !== key) {
        try {
          const series = await backend.candles(timeframe);
          setCandlesByTf((previous) => ({ ...previous, [series.timeframe_minutes]: series }));
          candleKey.current[timeframe] = key;
          setChartError("");
        } catch (candleError) {
          setChartError(candleError instanceof Error ? candleError.message : String(candleError));
        }
      }

      if (backend.kind === "supabase") {
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
  }, [authed, timeframe]);

  // The polling/Realtime effect below must not re-subscribe whenever refresh changes identity
  // (it does on every timeframe switch), so it always calls the latest refresh through a ref.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem("aurum-timeframe", String(timeframe));
    if (authed) void refreshRef.current(true);
  }, [timeframe, authed]);

  const selectedSetBar = useMemo(
    () => setTickers.find((row) => row.symbol === selectedSet)?.last_bar_time ?? "",
    [setTickers, selectedSet]
  );

  useEffect(() => {
    if (!authed || !selectedSet) return;
    let cancelled = false;
    backend
      .setHistory(selectedSet)
      .then((points) => { if (!cancelled) setSetHistory(points); })
      .catch((historyError) => { if (!cancelled) setSetPanelError(historyError instanceof Error ? historyError.message : String(historyError)); });
    return () => { cancelled = true; };
  }, [authed, selectedSet, selectedSetBar]);

  useEffect(() => {
    if (!selectedSet && setTickers.length) setSelectedSet(setTickers[0].symbol);
  }, [setTickers, selectedSet]);

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
    const unsubscribe = backend.onChange
      ? backend.onChange(() => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => void refreshRef.current(true), 1000);
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
              <span className="eyebrow">{status?.watcher.symbol || config?.symbol || "XAUUSDm"} · Exness MT5</span>
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
                <div><span>SET scanner</span><strong>{formatAgo(cloud.set_last_seen, clock)}</strong></div>
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
            <div><span className="eyebrow">Chart</span><h2>{status?.watcher.symbol || config?.symbol || "XAUUSDm"} · MACD 12 / 26 / 9</h2></div>
            <div className="tabs" role="tablist" aria-label="Timeframe">
              {(config?.timeframes?.length ? config.timeframes : [10, 15]).map((tf) => (
                <button key={tf} role="tab" aria-selected={tf === timeframe} className={tf === timeframe ? "active" : ""} onClick={() => setTimeframe(tf)}>
                  M{tf}
                </button>
              ))}
            </div>
          </div>
          <section className="panel chart-panel">
            {chartError && <div className="message error"><span>Chart data: {chartError}</span></div>}
            {candlesByTf[timeframe]?.candles.length ? (
              <CandleChart
                key={timeframe}
                candles={candlesByTf[timeframe].candles}
                alerts={alerts}
                symbol={candlesByTf[timeframe].symbol}
                timeframe={timeframe}
                forming={status?.watcher.timeframes[String(timeframe)]?.forming || candlesByTf[timeframe]?.forming}
              />
            ) : !chartError ? (
              <div className="empty-state">
                <span className="empty-ring" />
                <strong>No candles yet for M{timeframe}</strong>
                <p>{backend.kind === "supabase" ? "The laptop watcher publishes candles once it runs in cloud mode." : "Candles appear after the first evaluated bar."}</p>
              </div>
            ) : null}
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
                      <tr><td className="empty-cell" colSpan={6}>{setPanelError ? "Could not load SET data." : "The SET scanner has not stored any values yet. Enable it in Supabase settings (set_scan_enabled) after the dry run."}</td></tr>
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
                {selectedSet && setHistory.length > 1 && (
                  <div className="chart-panel">
                    <div className="chart-legend">
                      <span>{selectedSet.replace(/^SET:/, "")} · MACD history · {setHistory.length} bars · times in Bangkok</span>
                    </div>
                    <MacdChart points={setHistory} />
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
