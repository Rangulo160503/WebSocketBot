import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { placeOrder } from "./services/binanceTrade.js";

/** === Constantes / parámetros de scalping === */
const WS_BASE = "wss://stream.binance.com:9443/ws";
const REST_BASE = "https://api.binance.com/api/v3";
const IS_REAL = true;                // SIEMPRE en REAL
const DEFAULT_USD_BUDGET = 12;       // presupuesto por entrada
const SCALP = {
  WINDOW_SEC: 10,        // mira solo 10s de historia (antes 20)
  VOL_TPS_FACTOR: 1.00,  // casi sin filtro de volumen (antes 1.03)
  REBOUND_PCT: 0.0008,   // 0.08% desde el mínimo reciente (antes 0.20%)
  TP_PCT: 0.0006,        // +0.06% take profit (antes 0.12%)
  SL_PCT: 0.0006,        // -0.06% stop loss (antes 0.10%)
  COOLDOWN_MS: 2000,     // 2s entre órdenes (antes 7s)
  BREAKOUT_PCT: 0.0002,  // 0.02% breakout micro por encima del máximo reciente
};

/** === Exchange info / guards === */
async function fetchSymbolFilters(symbol) {
  const res = await fetch(`${REST_BASE}/exchangeInfo?symbol=${symbol}`);
  const j = await res.json();
  const s = j.symbols?.[0];
  if (!s) throw new Error("exchangeInfo vacío");
  const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceF = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const notional = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    tickSize: Number(priceF.tickSize),
    minNotional: Number(notional.minNotional),
  };
}
function roundToStep(qty, step) {
  if (!step) return qty;
  return Math.floor((qty + 1e-12) / step) * step;
}
function canNotional(qty, price, minNotional = 5) {
  return qty * price >= minNotional;
}

/** === Utils === */
const log = {
  info: (...a) => console.info("[BINANCE-UI]", ...a),
  warn: (...a) => console.warn("[BINANCE-UI]", ...a),
  error: (...a) => console.error("[BINANCE-UI]", ...a),
  debug: (...a) => console.debug("[BINANCE-UI]", ...a),
};
function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function msToTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}
function parseKlineRow(row) {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    trades: row[8],
  };
}

/** === Señal por minuto (UI informativa) === */
function computeSignal(currOpen, currClose) {
  if (currClose > currOpen) return "COMPRA";
  if (currClose < currOpen) return "VENTA";
  return "NEUTRAL";
}
function SignalBadge({ signal }) {
  const styles =
    signal === "COMPRA"
      ? "bg-emerald-600/20 text-emerald-300 border-emerald-500/30"
      : signal === "VENTA"
      ? "bg-rose-600/20 text-rose-300 border-rose-500/30"
      : "bg-slate-600/20 text-slate-300 border-slate-500/30";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-sm border ${styles}`}>
      {signal}
    </span>
  );
}
function KlineSignal({ symbol, interval = "1m", volFactor = 1.2 }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [view, setView] = useState(null);

  async function fetch3() {
    try {
      setLoading(true);
      setErr("");
      const u = new URL(`${REST_BASE}/klines`);
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("interval", interval);
      u.searchParams.set("limit", "3");
      const res = await fetch(u.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 2) throw new Error("Menos de 2 velas devueltas");
      const prev = parseKlineRow(data[data.length - 2]);
      const curr = parseKlineRow(data[data.length - 1]);
      const signal = computeSignal(curr.open, curr.close);
      const confirmed = curr.volume >= prev.volume * volFactor;
      const timeLabel = new Date(curr.openTime).toLocaleTimeString();
      setView({ timeLabel, prev, curr, signal, confirmed });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetch3();
    const now = Date.now();
    const toNextMinute = 60000 - (now % 60000);
    const t1 = setTimeout(() => {
      fetch3();
      const t2 = setInterval(fetch3, 60000);
      (window).__klineSignalT2 = t2;
    }, toNextMinute);
    return () => {
      clearTimeout(t1);
      if ((window).__klineSignalT2) clearInterval((window).__klineSignalT2);
    };
  }, [symbol, interval, volFactor]);

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-neutral-300">Señal por minuto</h3>
        {view?.signal && <SignalBadge signal={view.signal} />}
      </div>
      {err && <p className="text-rose-400 text-sm">Error: {err}</p>}
      {!err && (
        <div className="text-sm text-neutral-300 space-y-1">
          <div className="text-neutral-400">
            Hora: <span className="text-neutral-200">{view?.timeLabel || "—"}</span>
          </div>
          <div>
            Vela anterior:{" "}
            <span className="text-neutral-100">
              {view ? view.prev.open.toLocaleString() : "—"} → {view ? view.prev.close.toLocaleString() : "—"} · Vol{" "}
              {view ? view.prev.volume.toLocaleString() : "—"}
            </span>
          </div>
          <div>
            Vela actual:{" "}
            <span className="text-neutral-100">
              {view ? view.curr.open.toLocaleString() : "—"} → {view ? view.curr.close.toLocaleString() : "—"} · Vol{" "}
              {view ? view.curr.volume.toLocaleString() : "—"}
            </span>
          </div>
          <div className="pt-1">
            Validación por volumen (×{volFactor}):{" "}
            {view ? (
              <span className={view.confirmed ? "text-emerald-300" : "text-slate-300"}>
                {view.confirmed ? "confirmada" : "no confirmada"}
              </span>
            ) : (
              "—"
            )}
          </div>
          {loading && <div className="text-xs text-neutral-500 mt-2">Actualizando…</div>}
        </div>
      )}
    </div>
  );
}

/** === Agregado por segundo (UI) === */
function aggregatePerSecond(trades) {
  const bySec = new Map();
  for (const t of trades) {
    const s = Math.floor(t.ts / 1000);
    const ex = bySec.get(s);
    if (!ex) bySec.set(s, { sec: s, open: t.price, high: t.price, low: t.price, close: t.price, volume: 1 });
    else {
      ex.high = Math.max(ex.high, t.price);
      ex.low = Math.min(ex.low, t.price);
      ex.close = t.price;
      ex.volume += 1;
    }
  }
  const arr = Array.from(bySec.values()).sort((a, b) => a.sec - b.sec);
  return arr.slice(-120).map((b) => ({ ...b, time: new Date(b.sec * 1000).toLocaleTimeString() }));
}
function SecondBars({ trades }) {
  const data = useMemo(() => aggregatePerSecond(trades), [trades]);
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-neutral-300">Cierres por segundo (últ. 120s)</h3>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis dataKey="time" hide />
            <YAxis domain={["auto", "auto"]} tick={{ fill: "#9CA3AF", fontSize: 12 }} />
            <Tooltip isAnimationActive={false} allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={{ pointerEvents: "none", zIndex: 0 }} position={{ y: 0 }} />
            <Line type="monotone" dataKey="close" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** === Componente principal (scalping real) === */
export default function BinanceLiveUI() {
  /** ---- Config / estado base ---- */
  const [symbol] = useState("BTCUSDT");
  const [interval] = useState("1m");

  // Bot / exchange
  const [inFlight, setInFlight] = useState(false);
  const [cooldownMs] = useState(SCALP.COOLDOWN_MS);
  const lastTradeTimeRef = useRef(0);
  const lastSideRef = useRef(null);
  const [fx, setFx] = useState({ stepSize: 0.00001, minNotional: 5 });
  const [usdBudget] = useState(DEFAULT_USD_BUDGET);

  // Kline + último trade (defínelos antes de cualquier useMemo que los use)
  const [kPrev, setKPrev] = useState(null);
  const [kCurr, setKCurr] = useState(null);
  const [lastTrade, setLastTrade] = useState(null);

  // Posición spot (LONG only en spot)
  const [pos, setPos] = useState(null); // {entry, qty, time}

  // Wallet y derivados
  const [wallet, setWallet] = useState({ usdt: 0, btc: 0 });
  const priceNow = useMemo(() => lastTrade?.price ?? kCurr?.close ?? 0, [lastTrade, kCurr]);
  const btcValue = useMemo(() => wallet.btc * (priceNow || 0), [wallet.btc, priceNow]);
  const totalValue = useMemo(() => wallet.usdt + btcValue, [wallet.usdt, btcValue]);

  // UI / datos live
  const [autoBuyExecuted, setAutoBuyExecuted] = useState(false);
  const [readyToSell, setReadyToSell] = useState(false);
  const [streamStatus, setStreamStatus] = useState("disconnected");
  const [lastLatency, setLastLatency] = useState(null);
  const [trades, setTrades] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);

  // Otros estados auxiliares
  const [loadingKline, setLoadingKline] = useState(false);
  const [klineErr, setKlineErr] = useState("");

  // Refs
  const wsRef = useRef(null);
  const listRef = useRef(null);

  /** ---- WS helpers ---- */
  const cleanupWS = () => {
    try {
      if (wsRef.current && wsRef.current.readyState <= 1) wsRef.current.close(1000, "client navigating");
    } catch {}
    wsRef.current = null;
  };

  const connectWS = () => {
    cleanupWS();
    setStreamStatus("connecting");
    const url = `${WS_BASE}/${symbol.toLowerCase()}@trade`;
    try {
      const socket = new WebSocket(url);
      wsRef.current = socket;
      socket.onopen = () => setStreamStatus("connected");
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const latency = Date.now() - Number(msg.E);
          setLastLatency(latency);
          const trade = { id: msg.t, price: Number(msg.p), qty: Number(msg.q), eventTime: msg.E, tradeTime: msg.T, isMaker: msg.m };
          setLastTrade(trade);
          setTrades((prev) => [...prev, { ts: msg.T, price: trade.price, qty: trade.qty, time: new Date(msg.T).toLocaleTimeString() }]);
        } catch (e) {
          log.warn("WS parse error:", e);
        }
      };
      socket.onerror = () => setStreamStatus("error");
      socket.onclose = () => {
        setStreamStatus("disconnected");
        setTimeout(() => connectWS(), 2000); // reconexión simple
      };
    } catch (e) {
      setStreamStatus("error");
      log.error("WS connect error:", e);
    }
  };

  // Autoconectar al montar + limpiar al desmontar
  useEffect(() => {
    connectWS();
    return () => cleanupWS();
  }, []);

  // Cargar filtros del símbolo
  useEffect(() => {
    (async () => {
      try {
        const f = await fetchSymbolFilters(symbol);
        setFx({ stepSize: f.stepSize || 0.00001, minNotional: f.minNotional || 5 });
      } catch (e) {
        log.warn("exchangeInfo error:", e);
        setFx({ stepSize: 0.00001, minNotional: 5 });
      }
    })();
  }, [symbol]);

  // Auto-scroll
  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [trades, autoScroll]);

 /** === Balance polling === */
async function refreshBalances() {
  try {
    const res = await fetch("http://localhost:3000/balance");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    // Log para depuración
    console.log("[/balance] raw:", json);

    // Extraer USDT y BTC directamente de json.spot (si existe)
    const usdt = json.spot?.usdt?.free ??
      Number((json.balances || []).find(b => b.asset === "USDT")?.free || 0);

    const btc = json.spot?.btc?.free ??
      Number((json.balances || []).find(b => b.asset === "BTC")?.free || 0);

    setWallet({ usdt, btc });
  } catch (e) {
    console.warn("balance fetch error:", e);
  }
}


  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, 15_000);
    return () => clearInterval(t);
  }, []);

  /** === Fetch kline (2 últimas velas) solo para UI === */
  const fetchKline2 = async () => {
    setLoadingKline(true);
    setKlineErr("");
    try {
      const u = new URL(`${REST_BASE}/klines`);
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("interval", "1m");
      u.searchParams.set("limit", "2");
      const res = await fetch(u.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKPrev(parseKlineRow(data[0]));
      setKCurr(parseKlineRow(data[1]));
    } catch (err) {
      setKlineErr(String(err?.message || err));
    } finally {
      setLoadingKline(false);
    }
  };
  useEffect(() => {
    fetchKline2();
    const now = Date.now();
    const toNextMinute = 60000 - (now % 60000);
    const t1 = setTimeout(() => {
      fetchKline2();
      const t2 = setInterval(fetchKline2, 60000);
      (window).__klineFetch2 = t2;
    }, toNextMinute);
    return () => {
      clearTimeout(t1);
      if ((window).__klineFetch2) clearInterval((window).__klineFetch2);
    };
  }, [symbol]);

  /** === Envío de órdenes (REAL) — devuelve qtyUsed consistente === */
  async function execOrderMarket({ side, price, usdBudget, qtyFixed }) {
    if (inFlight) return { skipped: "inFlight" };
    const now = Date.now();
    if (now - lastTradeTimeRef.current < cooldownMs) return { skipped: "cooldown" };
    if (!price) throw new Error("price requerido");

    // qty: fija (para SELL de la posición) o por presupuesto (para BUY)
    let qty;
    let qtyUsed;
    if (qtyFixed != null) {
      qty = roundToStep(Number(qtyFixed), fx.stepSize);
      qtyUsed = qty;
    } else {
      // no te pases del USDT libre
      const budget = Math.max(0, Math.min(usdBudget ?? DEFAULT_USD_BUDGET, wallet.usdt * 0.98));
      const qtyRaw = budget / price;
      qty = Math.max(roundToStep(qtyRaw, fx.stepSize), fx.stepSize);
      qtyUsed = qty;
    }
    if (!canNotional(qty, price, fx.minNotional)) return { skipped: "min-notional" };

    try {
      setInFlight(true);
      if (!IS_REAL) {
        lastTradeTimeRef.current = now;
        lastSideRef.current = side;
        log.info("SIM", side, qty, "@~", price);
        return { sim: true, side, qty: qtyUsed, price };
      }
      const res = await placeOrder({ symbol: "BTCUSDT", side, type: "MARKET", quantity: qty });
      lastTradeTimeRef.current = now;
      lastSideRef.current = side;
      refreshBalances();
      log.info("REAL", side, qty, "@~", price, res?.status);
      return { ...res, qtyUsed };
    } finally {
      setInFlight(false);
    }
  }

  /** === Lógica de SCALPING por segundo (entrada + TP/SL) === */
  useEffect(() => {
  if (!lastTrade) return;

  const secs = aggregatePerSecond(trades);
  if (secs.length < 4) return;

  const last  = secs.at(-1);
  const prev  = secs.at(-2);
  const recent = secs.slice(-SCALP.WINDOW_SEC);

  const recentLow  = Math.min(...recent.map(s => s.low));
  const recentHigh = Math.max(...recent.map(s => s.high));

  // volumen casi sin filtro para permitir más señales
  const volOK = last.volume >= prev.volume * SCALP.VOL_TPS_FACTOR;

  // Señal 1: Rebound micro desde el mínimo reciente
  const reboundOK = last.close >= recentLow * (1 + SCALP.REBOUND_PCT);

  // Señal 2: Micro-breakout por encima del máximo reciente
  const breakoutOK = last.close >= recentHigh * (1 + SCALP.BREAKOUT_PCT) && last.close > prev.close;

  (async () => {
    // ENTRADA: si no hay posición y se da rebote O breakout (con volOK)
    if (!pos && volOK && (reboundOK || breakoutOK)) {
      const r = await execOrderMarket({ side: "BUY", price: last.close, usdBudget: DEFAULT_USD_BUDGET });
      if (!r?.skipped) {
        const qty = Number(r?.qtyUsed || (DEFAULT_USD_BUDGET / last.close));
        setPos({ entry: last.close, qty, time: Date.now() });
        setAutoBuyExecuted(true);
        setTimeout(() => setAutoBuyExecuted(false), 3500);
      }
    }

    // SALIDA: TP/SL más apretados (permiten re-entrada rápida)
    if (pos) {
      const pnlPct = (last.close - pos.entry) / pos.entry;
      if (pnlPct >= SCALP.TP_PCT || pnlPct <= -SCALP.SL_PCT) {
        setReadyToSell(true);
        await execOrderMarket({ side: "SELL", price: last.close, qtyFixed: pos.qty });
        setPos(null);
        setTimeout(() => setReadyToSell(false), 3500);
      }
    }
  })();
}, [trades, lastTrade, pos]);


  /** === Chart data === */
  const chartData = useMemo(() => trades.map((t) => ({ time: t.time, price: t.price })), [trades]);

  const statusBadge =
    streamStatus === "connected"
      ? "bg-emerald-500"
      : streamStatus === "connecting"
      ? "bg-amber-500"
      : streamStatus === "error"
      ? "bg-rose-500"
      : "bg-slate-500";

  const pnlPctLive = pos && priceNow ? ((priceNow - pos.entry) / pos.entry) * 100 : 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200">
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur border-b border-white/10 bg-neutral-900/80">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg font-semibold tracking-tight">Binance Live: Auto-bot (Scalping)</div>
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusBadge}`}>{streamStatus}</span>
          {lastLatency != null && <span className="text-xs text-neutral-400">latency: {fmt(lastLatency)} ms</span>}
          <div className="ml-auto text-xs text-rose-300 font-semibold">Modo: REAL · Auto ON</div>
        </div>
      </header>

      <main className="max-w-15xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Columna izquierda */}
        <section className="lg:col-span-1 space-y-4">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
            <KlineSignal symbol={symbol} interval="1m" />
          </div>

          {/* Wallet card */}
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
            <h2 className="text-sm font-semibold text-neutral-300 mb-2">Mi Balance</h2>
            <div className="text-sm text-neutral-300 space-y-1">
              <div>USDT libre: <span className="text-neutral-100">{fmt(wallet.usdt, 4)}</span></div>
              <div>BTC libre: <span className="text-neutral-100">{fmt(wallet.btc, 8)}</span></div>
              <div>BTC en USDT (en juego): <span className="text-emerald-300">≈ {fmt(btcValue, 2)} USDT</span></div>
              <div>Total estimado: <span className="text-neutral-100">≈ {fmt(totalValue, 2)} USDT</span></div>
              <div className="text-xs text-neutral-500 mt-1">Budget por operación: ~{DEFAULT_USD_BUDGET} USDT</div>
            </div>
          </div>

          {/* Posición actual */}
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
            <h2 className="text-sm font-semibold text-neutral-300 mb-2">Posición</h2>
            {!pos ? (
              <div className="text-sm text-neutral-500">Sin posición abierta.</div>
            ) : (
              <div className="text-sm text-neutral-300 space-y-1">
                <div>Entrada: <span className="text-neutral-100">{fmt(pos.entry, 2)}</span></div>
                <div>Cantidad: <span className="text-neutral-100">{fmt(pos.qty, 8)} BTC</span></div>
                <div>PNL live: <span className={pnlPctLive >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  {fmt(pnlPctLive, 4)}%
                </span></div>
                <div className="text-xs text-neutral-500">TP {SCALP.TP_PCT * 100}% · SL {SCALP.SL_PCT * 100}% · CD {cooldownMs / 1000}s</div>
              </div>
            )}
            {readyToSell && (
              <div className="mt-3 p-2 rounded bg-rose-900/30 border border-rose-500/30 text-rose-200 text-xs">
                Salida ejecutada (TP/SL).
              </div>
            )}
            {autoBuyExecuted && (
              <div className="mt-3 p-2 rounded bg-emerald-900/30 border border-emerald-500/30 text-emerald-200 text-xs">
                Entrada ejecutada por rebote.
              </div>
            )}
          </div>
        </section>

        {/* Chart */}
        <section className="lg:col-span-1">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow h-full">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-neutral-300">Precio en vivo (últimos {trades.length} trades)</h2>
              {lastTrade && (
                <div className="text-xs text-neutral-400">
                  Último: <span className="text-neutral-100 font-medium">{fmt(lastTrade.price, 2)}</span> · {msToTime(lastTrade.tradeTime)}
                </div>
              )}
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
                  <XAxis dataKey="time" hide />
                  <YAxis domain={["auto", "auto"]} tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                  <Tooltip contentStyle={{ background: "#0a0a0a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="price" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <SecondBars trades={trades} />
          </div>
        </section>

        {/* Tabla de trades */}
        <section className="lg:col-span-1 space-y-6">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-neutral-300">Trades recientes</h3>
              <button
                className="text-xs px-2 py-1 rounded bg-neutral-800 border border-white/10 hover:bg-neutral-700"
                onClick={() => setTrades([])}
              >
                Limpiar
              </button>
            </div>
            <div ref={listRef} className="h-56 overflow-auto rounded-lg border border-white/10 bg-neutral-950/60">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Hora</th>
                    <th className="text-right px-3 py-2 font-medium">Precio</th>
                    <th className="text-right px-3 py-2 font-medium">Cantidad</th>
                    <th className="text-center px-3 py-2 font-medium">Lado</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length ? (
                    trades.slice(-100).map((tp, i) => (
                      <tr key={i} className="odd:bg-neutral-900/40">
                        <td className="px-3 py-1.5 text-neutral-400">{tp.time}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(tp.price, 2)}</td>
                        <td className="px-3 py-1.5 text-right text-neutral-400">—</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className="inline-flex px-2 py-0.5 rounded text-xs bg-neutral-800/60 text-neutral-300">—</span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-3 py-3 text-neutral-500" colSpan={4}>
                        Sin datos aún. Conecta el WebSocket.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs text-neutral-500">
        Bot spot auto. Considera límites de riesgo y el budget por trade.
      </footer>
    </div>
  );
}
