import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { placeOrder } from "./services/binanceTrade.js";

/** ===== Config (activo para ver trades hoy) ===== */
const BACK = "http://localhost:3000";
const WS_BASE = "wss://stream.binance.com/ws";

// Cambia si quieres otro par (SOLUSDT suele moverse más)
const SYMBOL = "ETHUSDT";

const MAX_SLOTS = 1;        // una posición a la vez
const SLOT_ALLOC_PCT = 1.0; // all-in controlado (98% efectivo en exec)

const SCALP = {
  // Señal
  WINDOW_SEC:     5,
  VOL_TPS_FACTOR: 1.00,
  REBOUND_PCT:    0.00025,   // 0.025%
  BREAKOUT_PCT:   0.00010,   // 0.010%

  // Gestión de salida (reactiva)
  TP_PCT:         0.0020,    // 0.20%
  SL_PCT:         0.0025,    // 0.25%
  TIMEOUT_MS:     45000,     // cierre por tiempo

  // Breakeven & trailing
  BE_PCT:         0.0015,    // arma BE a +0.15%
  BE_LOCK_PCT:    0.0002,    // fija stop en +0.02%
  TRAIL_ARM_PCT:  0.0025,    // arma trailing a +0.25%
  TRAIL_PCT:      0.0010,    // trailing 0.10%

  // Ritmo
  COOLDOWN_MS:    8000
};

// Gates de “ms” (relajados para actividad)
const MAX_TICK_LATENCY_MS = 400;
const MAX_BAR_STALE_MS    = 800;

/** ===== Utils ===== */
const log = {
  info:  (...a) => console.info("[BINANCE-UI]", ...a),
  warn:  (...a) => console.warn("[BINANCE-UI]", ...a),
  error: (...a) => console.error("[BINANCE-UI]", ...a),
};
function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function uuidOrderId(prefix = "UI") {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}
function roundToStep(qty, step) {
  return step ? Math.floor((qty + 1e-12) / step) * step : qty;
}
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
  return Array.from(bySec.values()).sort((a, b) => a.sec - b.sec);
}

/** ===== Filtros (exchangeInfo) ===== */
async function fetchSymbolFilters(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const s = j.symbols?.[0];
  if (!s) throw new Error("exchangeInfo vacío");

  const lot       = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const priceF    = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const notionalF = s.filters.find((f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");

  return {
    stepSize:    Number(lot?.stepSize ?? 0.00001),
    minQty:      Number(lot?.minQty ?? 0),
    tickSize:    Number(priceF?.tickSize ?? 0.01),
    minNotional: Number((notionalF?.minNotional ?? notionalF?.notional) ?? 5),
  };
}

/** === Tabla de fills reales (consulta /mytrades) === */
function RecentFills({ symbol }) {
  const [fills, setFills] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    let t;
    const tick = async () => {
      try {
        const r = await fetch(`${BACK}/mytrades?symbol=${symbol}&limit=10`);
        if (!alive) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) setFills(Array.isArray(j) ? j : []);
        setErr("");
      } catch (e) {
        if (alive) setErr(e?.message || String(e));
      }
      if (alive) t = setTimeout(tick, 5000); // 5s
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [symbol]);

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-neutral-300">Fills recientes ({symbol})</h3>
        {err && <span className="text-xs text-rose-400">/mytrades: {err}</span>}
      </div>
      <div className="h-48 overflow-auto rounded-lg border border-white/10 bg-neutral-950/60">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
            <tr>
              <th className="text-left px-3 py-2">Hora</th>
              <th className="text-left px-3 py-2">Par</th>
              <th className="text-center px-3 py-2">Side</th>
              <th className="text-right px-3 py-2">Precio</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {fills.length ? fills.map((f, i) => {
              const isBuy = f.isBuyer ?? (f.side ? String(f.side).toUpperCase() === "BUY" : undefined);
              const price = Number(f.price ?? f.p ?? 0);
              const qty   = Number(f.qty   ?? f.q ?? 0);
              const total = Number(f.quoteQty ?? f.total ?? (price * qty));
              const t     = new Date(f.time ?? f.transactTime ?? f.T ?? Date.now()).toLocaleTimeString();
              return (
                <tr key={i} className="odd:bg-neutral-900/40">
                  <td className="px-3 py-1.5 text-neutral-400">{t}</td>
                  <td className="px-3 py-1.5">{f.symbol ?? symbol}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs ${isBuy ? "bg-emerald-800/50 text-emerald-200" : "bg-rose-800/50 text-rose-200"}`}>
                      {isBuy ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{price.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">{qty.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{total.toLocaleString()}</td>
                </tr>
              );
            }) : (
              <tr><td className="px-3 py-3 text-neutral-500" colSpan={6}>Sin fills aún…</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-neutral-500 mt-2">Fuente: {BACK}/mytrades (refresco 5s).</div>
    </div>
  );
}

/** ===== Componente principal ===== */
export default function BinanceLiveUI() {
  const [symbol] = useState(SYMBOL);

  // Estado de cuenta
  const [wallet, setWallet] = useState({ usdt: 0, btc: 0 });
  const [fx, setFx] = useState({ stepSize: 0.00001, minNotional: 5, tickSize: 0.01 });

  // WS / live
  const [streamStatus, setStreamStatus] = useState("disconnected");
  const [lastLatency, setLastLatency] = useState(null); // ms del tick
  const [trades, setTrades] = useState([]);
  const wsRef = useRef(null);

  // Slots (posición única)
  const [slots, setSlots] = useState([]); // [{entry, qty, time, maxPrice?}]

  // Métricas
  const [stats, setStats] = useState({ signals: 0, sent: 0, filled: 0 });
  const [perMin, setPerMin] = useState({ signals: 0, sent: 0, filled: 0 });
  const [sessionPnL, setSessionPnL] = useState({ trades: 0, realized: 0 });

  // Cooldown por lado
  const lastBuyRef = useRef(0);
  const lastSellRef = useRef(0);

  // Derivados UI
  const lastTrade = trades.at(-1) || null;
  const priceNow = lastTrade?.price ?? 0;
  const btcValue = wallet.btc * (priceNow || 0);
  const totalValue = wallet.usdt + btcValue;

  /** ---- WS connect ---- */
  useEffect(() => {
    const url = `${WS_BASE}/${symbol.toLowerCase()}@trade`;

    const connect = () => {
      try {
        setStreamStatus("connecting");
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => setStreamStatus("connected");
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const m = msg?.data ?? msg;
            if (!m?.p) return;

            const tickLatency = typeof m.E === "number" ? Date.now() - m.E : null;
            if (tickLatency != null) setLastLatency(tickLatency);
            if (tickLatency != null && tickLatency > MAX_TICK_LATENCY_MS) return;

            const t = { ts: m.T, price: Number(m.p), qty: Number(m.q), time: new Date(m.T).toLocaleTimeString() };
            setTrades((prev) => {
              const next = [...prev, t];
              if (next.length > 2000) next.splice(0, next.length - 2000);
              return next;
            });
          } catch {}
        };
        ws.onerror = () => setStreamStatus("error");
        ws.onclose = () => {
          setStreamStatus("disconnected");
          setTimeout(connect, 1500);
        };
      } catch {
        setStreamStatus("error");
      }
    };

    connect();
    return () => { try { wsRef.current?.close(); } catch {} };
  }, [symbol]);

  /** ---- Filtros ---- */
  useEffect(() => {
    (async () => {
      try {
        const f = await fetchSymbolFilters(symbol);
        setFx(f);
      } catch (e) {
        log.warn("exchangeInfo error:", e?.message || e);
        setFx({ stepSize: 0.00001, minNotional: 5, tickSize: 0.01 });
      }
    })();
  }, [symbol]);

  /** ---- Balance polling ---- */
  async function refreshBalances() {
    try {
      const res = await fetch(`${BACK}/balance`);
      const json = await res.json();
      const usdt = json.spot?.usdt?.free ?? Number((json.balances || []).find((b) => b.asset === "USDT")?.free || 0);
      const btc  = json.spot?.btc?.free  ?? Number((json.balances || []).find((b) => b.asset === "BTC")?.free  || 0);
      setWallet({ usdt, btc });
    } catch (e) { log.warn("balance fetch error:", e); }
  }
  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, 15_000);
    return () => clearInterval(t);
  }, []);

  /** ---- Snapshot por minuto ---- */
  useEffect(() => {
    const t = setInterval(() => {
      setPerMin(stats);
      setStats({ signals: 0, sent: 0, filled: 0 });
    }, 60_000);
    return () => clearInterval(t);
  }, [stats]);

  /** ---- Cooldown helpers ---- */
  const canSide = (side) => {
    const now = Date.now();
    if (side === "BUY"  && now - lastBuyRef.current  < SCALP.COOLDOWN_MS) return false;
    if (side === "SELL" && now - lastSellRef.current < SCALP.COOLDOWN_MS) return false;
    return true;
  };
  const markSide = (side) => {
    const now = Date.now();
    if (side === "BUY")  lastBuyRef.current  = now;
    if (side === "SELL") lastSellRef.current = now;
  };

  /** ---- Orden real (idempotente, all-in 98%) ---- */
  async function execOrderMarket({ side, price, qtyFixed }) {
    if (!canSide(side)) return { skipped: "cooldown" };
    if (!price)           return { skipped: "no-price" };

    let qty;
    if (qtyFixed != null) qty = roundToStep(Number(qtyFixed), fx.stepSize);
    else {
      const budget = Math.max(0, wallet.usdt * 0.98);
      qty = roundToStep(budget / price, fx.stepSize);
    }
    if (qty * price < fx.minNotional) return { skipped: "min-notional" };

    setStats((s) => ({ ...s, sent: s.sent + 1 }));
    try {
      const newClientOrderId = uuidOrderId(side[0]);
      const res = await placeOrder({ symbol, side, type: "MARKET", quantity: qty, newClientOrderId });
      markSide(side);
      setStats((s) => ({ ...s, filled: s.filled + 1 }));
      refreshBalances();
      return { ok: true, qtyUsed: qty, res };
    } catch (e) {
      log.error("order error:", e?.message || e);
      return { error: e?.message || "order-failed" };
    }
  }

  /** ---- Señales + slots con gates de ms + logs ---- */
  const secs = useMemo(() => aggregatePerSecond(trades), [trades]);

  useEffect(() => {
    if (secs.length < 4) return;

    const last   = secs.at(-1);
    const prev   = secs.at(-2);
    const recent = secs.slice(-SCALP.WINDOW_SEC);

    // Gates de frescura
    const barAgeMs = Date.now() - last.sec * 1000;
    const latencyOk = (lastLatency == null) || (lastLatency <= MAX_TICK_LATENCY_MS);
    const freshOk   = barAgeMs <= MAX_BAR_STALE_MS;

    if (!freshOk || !latencyOk) {
      console.debug("[GATE BLOCKED]", { freshOk, latencyOk, barAgeMs, lastLatency });
      return;
    }

    const recentLow  = Math.min(...recent.map(s => s.low));
    const recentHigh = Math.max(...recent.map(s => s.high));

    const volOK      = last.volume >= prev.volume * SCALP.VOL_TPS_FACTOR;
    const reboundOK  = last.close >= recentLow  * (1 + SCALP.REBOUND_PCT);
    const breakoutOK = last.close >= recentHigh * (1 + SCALP.BREAKOUT_PCT) && last.close > prev.close;

    // Fallback momentum 1s (±0.02%)
    const momentumOK = Math.abs((last.close - prev.close) / prev.close) >= 0.0002;

    console.debug("[SIGNAL CHECK]", {
      volOK, reboundOK, breakoutOK, momentumOK,
      lastClose: last.close, prevClose: prev.close,
      barAgeMs, lastLatency
    });

    const shouldEnter = volOK && (reboundOK || breakoutOK || momentumOK);
    if (shouldEnter) setStats(s => ({ ...s, signals: s.signals + 1 }));

    (async () => {
      // ===== ENTRADA =====
      if (shouldEnter && slots.length < MAX_SLOTS) {
        console.debug("[ENTER TRY]", { price: last.close, slotsOpen: slots.length });
        const r = await execOrderMarket({ side: "BUY", price: last.close });
        if (r?.ok) {
          const qty = r.qtyUsed ?? (wallet.usdt * 0.98) / last.close;
          setSlots([{ entry: last.close, qty, time: Date.now(), maxPrice: last.close }]);
          console.debug("[ENTER FILLED]", { entry: last.close, qty });
        } else {
          console.debug("[ENTER SKIPPED]", r);
        }
      }

      // ===== SALIDA TP/SL/Timeout/Trailing =====
      if (slots.length === 1) {
        const sl = { ...slots[0] }; // copia para calcular
        const now = Date.now();
        const ageMs = now - sl.time;

        // track máximo a favor
        if (last.close > (sl.maxPrice ?? sl.entry)) sl.maxPrice = last.close;

        const pnlPct = (last.close - sl.entry) / sl.entry;
        const hitTP  = pnlPct >= SCALP.TP_PCT;
        const hitSL  = pnlPct <= -SCALP.SL_PCT;

        // Breakeven: si llegamos a +BE_PCT, fijamos stop en +BE_LOCK_PCT
        let breakevenStop = null;
        if (pnlPct >= SCALP.BE_PCT) {
          breakevenStop = sl.entry * (1 + SCALP.BE_LOCK_PCT);
        }

        // Trailing: si avanzó +TRAIL_ARM_PCT, seguimos con cola TRAIL_PCT
        let trailingStop = null;
        if ((sl.maxPrice - sl.entry) / sl.entry >= SCALP.TRAIL_ARM_PCT) {
          trailingStop = sl.maxPrice * (1 - SCALP.TRAIL_PCT);
        }

        // Stop efectivo (mayor de los dos por encima del entry)
        let dynStop = null;
        if (breakevenStop && trailingStop) dynStop = Math.max(breakevenStop, trailingStop);
        else dynStop = breakevenStop ?? trailingStop;

        const hitDyn = dynStop ? last.close <= dynStop : false;

        const hitTimeout = ageMs >= SCALP.TIMEOUT_MS;

        console.debug("[POSITION CHECK]", {
          entry: sl.entry, lastClose: last.close, ageMs,
          pnlPct, hitTP, hitSL, dynStop, hitDyn, maxPrice: sl.maxPrice, hitTimeout
        });

        if (hitTP || hitSL || hitDyn || hitTimeout) {
          console.debug("[EXIT TRY]", { side: "SELL", price: last.close, qty: sl.qty });
          const r = await execOrderMarket({ side: "SELL", price: last.close, qtyFixed: sl.qty });
          if (r?.ok) {
            setSlots([]); // cerrada
            setSessionPnL(p => ({
              trades: p.trades + 1,
              realized: p.realized + (last.close - sl.entry) * sl.qty
            }));
            console.debug("[EXIT FILLED]", { exit: last.close, pnlPct });
          } else {
            console.debug("[EXIT SKIPPED]", r);
          }
        } else {
          // persistimos maxPrice actualizado
          setSlots([{ ...slots[0], maxPrice: sl.maxPrice }]);
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs.length, lastLatency]);

  /** ---- Chart data ---- */
  const chartData = useMemo(() => trades.slice(-1200).map((t) => ({ time: t.time, price: t.price })), [trades]);

  /** ===== UI ===== */
  const statusBadge =
    streamStatus === "connected"
      ? "bg-emerald-500"
      : streamStatus === "connecting"
      ? "bg-amber-500"
      : streamStatus === "error"
      ? "bg-rose-500"
      : "bg-slate-500";

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200">
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur border-b border-white/10 bg-neutral-900/80">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg font-semibold tracking-tight">Binance Live · Scalper (reactivo)</div>
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusBadge}`}>{streamStatus}</span>
          {lastLatency != null && <span className="text-xs text-neutral-400">latency tick: {fmt(lastLatency)} ms</span>}
          <div className="ml-auto text-xs flex items-center gap-4">
            <span>Señales/min: <b>{perMin.signals}</b></span>
            <span>Enviadas/min: <b>{perMin.sent}</b></span>
            <span>Llenadas/min: <b>{perMin.filled}</b></span>
            <span>Trades: <b>{sessionPnL.trades}</b></span>
            <span>PNL: <b className={sessionPnL.realized >= 0 ? "text-emerald-300" : "text-rose-300"}>{fmt(sessionPnL.realized, 2)} USDT</b></span>
            <span className="text-rose-300 font-semibold">REAL · All-in</span>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Columna izquierda: balance + fills */}
        <section className="lg:col-span-1 space-y-4">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow">
            <h2 className="text-sm font-semibold text-neutral-300 mb-2">Mi Balance</h2>
            <div className="text-sm text-neutral-300 space-y-1">
              <div>USDT libre: <span className="text-neutral-100">{fmt(wallet.usdt, 4)}</span></div>
              <div>BTC/ETH libre: <span className="text-neutral-100">{fmt(wallet.btc, 8)}</span></div>
              <div>Total estimado: <span className="text-neutral-100">≈ {fmt(totalValue, 2)} USDT</span></div>
              <div className="text-xs text-neutral-500 mt-1">TP 0.20% · SL 0.25% · TO 45s · BE+Trailing · CD 8s</div>
            </div>
          </div>

          {/* Fills en vivo */}
          <RecentFills symbol={symbol} />
        </section>

        {/* Chart derecha */}
        <section className="lg:col-span-2">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow h-full">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-neutral-300">Precio en vivo</h2>
              {lastTrade && (
                <div className="text-xs text-neutral-400">
                  Último: <span className="text-neutral-100 font-medium">{fmt(lastTrade.price, 2)}</span> · {lastTrade.time}
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
          </div>

          {/* Agregado por segundo */}
          <SecondBars trades={trades} />
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs text-neutral-500">
        Spot auto con salidas reactivas. Ajusta filtros según tu PnL y volatilidad.
      </footer>
    </div>
  );
}

/** === Subcomponente: barras 1s === */
function SecondBars({ trades }) {
  const data = useMemo(() => {
    const secs = aggregatePerSecond(trades).slice(-120);
    return secs.map((b) => ({ ...b, time: new Date(b.sec * 1000).toLocaleTimeString() }));
  }, [trades]);

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow mt-4">
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis dataKey="time" hide />
            <YAxis domain={["auto", "auto"]} tick={{ fill: "#9CA3AF", fontSize: 12 }} />
            <Tooltip isAnimationActive={false} />
            <Line type="monotone" dataKey="close" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
