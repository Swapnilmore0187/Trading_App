import { useState, useRef, useEffect, useCallback } from "react";

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  bg:     "#050709",
  panel:  "#0b0e18",
  border: "#141928",
  bull:   "#00e676",
  bear:   "#ff1744",
  neutral:"#ffd600",
  accent: "#2979ff",
  purple: "#7c4dff",
  text:   "#dce6f5",
  muted:  "#4a5578",
  grid:   "#0d1020",
};

// ── Indicator helpers ─────────────────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [];
  data.forEach((v, i) => {
    if (i < period - 1) { ema.push(null); return; }
    if (i === period - 1) { ema.push(data.slice(0, period).reduce((a, b) => a + b, 0) / period); return; }
    ema.push(v * k + ema[i - 1] * (1 - k));
  });
  return ema;
}

function calcRSI(closes, period = 14) {
  const rsi = Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = ema12.map((v, i) => (v != null && ema26[i] != null) ? v - ema26[i] : null);
  const signal = calcEMA(macd.map(v => v ?? 0), 9);
  const hist = macd.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  return { macd, signal, hist };
}

function detectPattern(candles) {
  if (candles.length < 3) return null;
  const [c1, c2, c3] = candles.slice(-3);
  const body1 = Math.abs(c1.close - c1.open);
  const body2 = Math.abs(c2.close - c2.open);
  const body3 = Math.abs(c3.close - c3.open);
  const range3 = c3.high - c3.low || 1;
  if (body3 / range3 < 0.1) return { name: "Doji", bias: "neutral" };
  if (c2.close < c2.open && c3.close > c3.open && c3.open <= c2.close && c3.close >= c2.open)
    return { name: "Bullish Engulfing", bias: "bullish" };
  if (c2.close > c2.open && c3.close < c3.open && c3.open >= c2.close && c3.close <= c2.open)
    return { name: "Bearish Engulfing", bias: "bearish" };
  const lowerWick3 = Math.min(c3.open, c3.close) - c3.low;
  const upperWick3 = c3.high - Math.max(c3.open, c3.close);
  if (lowerWick3 > body3 * 2 && upperWick3 < body3) return { name: "Hammer", bias: "bullish" };
  if (upperWick3 > body3 * 2 && lowerWick3 < body3) return { name: "Shooting Star", bias: "bearish" };
  if (c1.close < c1.open && body2 < body1 * 0.4 && c3.close > c3.open && c3.close > (c1.open + c1.close) / 2)
    return { name: "Morning Star", bias: "bullish" };
  if (c1.close > c1.open && body2 < body1 * 0.4 && c3.close < c3.open && c3.close < (c1.open + c1.close) / 2)
    return { name: "Evening Star", bias: "bearish" };
  return null;
}

// ── Fetch real Nifty 50 candles from Yahoo Finance via CORS proxy ──────────────
const INTERVALS = [
  { label: "5 Min",  value: "5m",  range: "1d"  },
  { label: "15 Min", value: "15m", range: "5d"  },
  { label: "1 Hour", value: "60m", range: "1mo" },
  { label: "1 Day",  value: "1d",  range: "6mo" },
];

async function fetchNiftyCandles(interval = "5m", range = "1d") {
  // Use allorigins as CORS proxy for Yahoo Finance chart API
  const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=${interval}&range=${range}&includePrePost=false`;
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(yUrl)}`;
  const res = await fetch(proxy);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const outer = await res.json();
  const data = JSON.parse(outer.contents);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No data from Yahoo Finance");
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const candles = ts.map((t, i) => ({
    ts: t * 1000,
    open:  +q.open[i]?.toFixed(2),
    high:  +q.high[i]?.toFixed(2),
    low:   +q.low[i]?.toFixed(2),
    close: +q.close[i]?.toFixed(2),
    vol:   q.volume[i] || 0,
  })).filter(c => c.open && c.high && c.low && c.close);
  return candles;
}

// ── SVG Candlestick chart ─────────────────────────────────────────────────────
function CandleChart({ candles, ema9, ema21, signals }) {
  const W = 720, H = 260, P = { t: 12, r: 12, b: 22, l: 68 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const n = candles.length;
  const candleW = Math.max(2, (cw / n) - 1.5);
  const prices = candles.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const range = maxP - minP || 1;
  const px = i => P.l + (i + 0.5) * (cw / n);
  const py = v => P.t + ch - ((v - minP) / range) * ch;
  const ticks = Array.from({ length: 5 }, (_, i) => minP + (range / 4) * i);

  const emaLine = (data, color) => {
    const pts = data.map((v, i) => v != null ? `${px(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean);
    return <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.4} opacity={0.85} />;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0b0e18" />
          <stop offset="100%" stopColor="#050709" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#bgGrad)" />
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={P.l} y1={py(t)} x2={W - P.r} y2={py(t)} stroke={C.grid} strokeWidth={1} />
          <text x={P.l - 6} y={py(t) + 4} fill={C.muted} fontSize={9} textAnchor="end">{t.toFixed(0)}</text>
        </g>
      ))}
      {/* Time labels every ~10 candles */}
      {candles.map((c, i) => i % Math.max(1, Math.floor(n / 7)) === 0 ? (
        <text key={i} x={px(i)} y={H - 4} fill={C.muted} fontSize={8} textAnchor="middle">
          {new Date(c.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </text>
      ) : null)}
      {emaLine(ema9, C.neutral)}
      {emaLine(ema21, C.accent)}
      {candles.map((c, i) => {
        const x = px(i);
        const isBull = c.close >= c.open;
        const col = isBull ? C.bull : C.bear;
        const bTop = py(Math.max(c.open, c.close));
        const bBot = py(Math.min(c.open, c.close));
        const bH = Math.max(1, bBot - bTop);
        return (
          <g key={i}>
            <line x1={x} y1={py(c.high)} x2={x} y2={py(c.low)} stroke={col} strokeWidth={1} opacity={0.8} />
            <rect x={x - candleW / 2} y={bTop} width={candleW} height={bH}
              fill={isBull ? col : col} stroke={col} strokeWidth={0.5} opacity={0.9} rx={0.5} />
          </g>
        );
      })}
      {signals.map((s, i) => {
        const idx = candles.findIndex(c => Math.abs(c.ts - s.ts) < 60000 * 60);
        if (idx < 0) return null;
        const x = px(idx);
        const isBuy = s.action === "BUY";
        return (
          <g key={i}>
            <circle cx={x} cy={isBuy ? py(candles[idx].low) + 20 : py(candles[idx].high) - 20}
              r={9} fill={isBuy ? C.bull : C.bear} opacity={0.18} />
            <text x={x} y={isBuy ? py(candles[idx].low) + 24 : py(candles[idx].high) - 16}
              textAnchor="middle" fontSize={11} fill={isBuy ? C.bull : C.bear} fontWeight="bold">
              {isBuy ? "▲" : "▼"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function RSIChart({ rsi }) {
  const W = 720, H = 72, P = { t: 6, r: 12, b: 16, l: 68 };
  const vals = rsi.filter(v => v != null);
  if (!vals.length) return null;
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const n = rsi.length;
  const px = i => P.l + (i + 0.5) * (cw / n);
  const py = v => P.t + ch - (v / 100) * ch;
  const pts = rsi.map((v, i) => v != null ? `${px(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean).join(" ");
  const last = vals[vals.length - 1];
  const col = last > 70 ? C.bear : last < 30 ? C.bull : C.neutral;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <rect width={W} height={H} fill={C.panel} />
      {[30, 50, 70].map(l => (
        <g key={l}>
          <line x1={P.l} y1={py(l)} x2={W - P.r} y2={py(l)}
            stroke={l === 70 ? C.bear : l === 30 ? C.bull : C.muted}
            strokeWidth={0.7} strokeDasharray={l !== 50 ? "3,3" : "0"} opacity={0.5} />
          <text x={P.l - 6} y={py(l) + 3} fill={C.muted} fontSize={8} textAnchor="end">{l}</text>
        </g>
      ))}
      <polyline points={pts} fill="none" stroke={col} strokeWidth={1.6} />
      <text x={W - P.r - 2} y={P.t + 10} fill={col} fontSize={9} textAnchor="end" fontWeight="bold">RSI {last?.toFixed(1)}</text>
    </svg>
  );
}

function MACDChart({ hist }) {
  const W = 720, H = 60, P = { t: 6, r: 12, b: 14, l: 68 };
  const vals = hist.filter(v => v != null);
  if (!vals.length) return null;
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const n = hist.length;
  const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
  const px = i => P.l + (i + 0.5) * (cw / n);
  const barW = Math.max(1, cw / n - 1.5);
  const midY = P.t + ch / 2;
  const scaleY = (ch / 2) / maxAbs;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <rect width={W} height={H} fill={C.panel} />
      <line x1={P.l} y1={midY} x2={W - P.r} y2={midY} stroke={C.muted} strokeWidth={0.5} />
      <text x={W - P.r - 2} y={P.t + 10} fill={C.muted} fontSize={9} textAnchor="end">MACD</text>
      {hist.map((v, i) => {
        if (v == null) return null;
        const h = Math.abs(v) * scaleY;
        return <rect key={i} x={px(i) - barW / 2} y={v >= 0 ? midY - h : midY} width={barW} height={h}
          fill={v >= 0 ? C.bull : C.bear} opacity={0.8} />;
      })}
    </svg>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function NiftyAgent() {
  const [candles, setCandles] = useState([]);
  const [signals, setSignals] = useState([]);
  const [decision, setDecision] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState("chart");
  const [intervalCfg, setIntervalCfg] = useState(INTERVALS[0]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);
  const logRef = useRef(null);

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev.slice(-49), { msg, type, ts: new Date().toLocaleTimeString() }]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // ── Fetch candles ───────────────────────────────────────────────────────────
  const loadCandles = useCallback(async (cfg = intervalCfg, silent = false) => {
    if (!silent) setFetching(true);
    setFetchError(null);
    if (!silent) addLog(`📡 Fetching Nifty 50 (^NSEI) — ${cfg.label} candles…`, "info");
    try {
      const data = await fetchNiftyCandles(cfg.value, cfg.range);
      setCandles(data);
      if (!silent) {
        addLog(`✅ Loaded ${data.length} candles from Yahoo Finance`, "bull");
        addLog(`📌 Latest close: ₹${data[data.length - 1]?.close}`, "info");
      }
    } catch (e) {
      const msg = `❌ API Error: ${e.message}`;
      setFetchError(msg);
      if (!silent) addLog(msg, "error");
    }
    if (!silent) setFetching(false);
  }, [intervalCfg]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => loadCandles(intervalCfg, true), 30000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, intervalCfg, loadCandles]);

  // Initial load
  useEffect(() => { loadCandles(INTERVALS[0]); }, []);

  // ── Derived indicators ──────────────────────────────────────────────────────
  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes);
  const { hist: macdHist } = calcMACD(closes);
  const pattern = candles.length >= 3 ? detectPattern(candles) : null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const priceChange = last && prev ? last.close - prev.close : 0;
  const pctChange = prev ? (priceChange / prev.close * 100).toFixed(2) : "0.00";
  const lastRSI = rsi.filter(v => v != null).slice(-1)[0];
  const lastMACD = macdHist.filter(v => v != null).slice(-1)[0];
  const lastEMA9 = ema9.filter(v => v != null).slice(-1)[0];
  const lastEMA21 = ema21.filter(v => v != null).slice(-1)[0];

  // ── AI Analysis ─────────────────────────────────────────────────────────────
  const analyze = useCallback(async () => {
    if (!candles.length) return;
    setAnalyzing(true);
    setDecision(null);
    addLog("🤖 Agent analysing real market data…", "info");
    addLog(`EMA9: ${lastEMA9?.toFixed(1)} | EMA21: ${lastEMA21?.toFixed(1)}`, "info");
    addLog(`RSI: ${lastRSI?.toFixed(1)} | MACD Hist: ${lastMACD?.toFixed(2)}`, "info");
    addLog(`Pattern: ${pattern?.name || "None"} | Interval: ${intervalCfg.label}`, "info");

    const recent = candles.slice(-10).map(c =>
      `O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.vol}`
    );

    const prompt = `You are a senior NSE Nifty 50 options trader & technical analyst. 
Analyse these LIVE candlestick data points and give a precise BUY CALL, BUY PUT, or HOLD signal.

Index: Nifty 50 (^NSEI)
Interval: ${intervalCfg.label}
Current Price: ₹${last?.close}
Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)} (${pctChange}%)

Last 10 Candles (OHLCV):
${recent.join("\n")}

Technical Indicators:
- EMA 9: ${lastEMA9?.toFixed(2)} | EMA 21: ${lastEMA21?.toFixed(2)}
- EMA Signal: ${lastEMA9 > lastEMA21 ? "Bullish crossover (EMA9 > EMA21)" : "Bearish crossover (EMA9 < EMA21)"}
- RSI(14): ${lastRSI?.toFixed(2)} — ${lastRSI > 70 ? "OVERBOUGHT ⚠️" : lastRSI < 30 ? "OVERSOLD 🔥" : "Neutral zone"}
- MACD Histogram: ${lastMACD?.toFixed(4)} — ${lastMACD > 0 ? "Bullish momentum" : "Bearish momentum"}
- Candlestick Pattern: ${pattern ? `${pattern.name} (${pattern.bias} bias)` : "No classic pattern detected"}

Respond ONLY with a raw JSON object (no markdown):
{
  "action": "BUY_CALL" | "BUY_PUT" | "HOLD",
  "confidence": 0-100,
  "entry": number,
  "target": number,
  "stopLoss": number,
  "reasoning": "2-3 sentence explanation",
  "keySignals": ["signal1","signal2","signal3","signal4"],
  "risk": "LOW"|"MEDIUM"|"HIGH",
  "timeframe": "string e.g. Intraday / Positional"
}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const raw = data.content?.find(b => b.type === "text")?.text || "{}";
      const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
      setDecision(result);
      setSignals(prev => [...prev.slice(-9), {
        ts: last.ts,
        action: result.action === "BUY_CALL" ? "BUY" : result.action === "BUY_PUT" ? "SELL" : "HOLD",
      }]);
      addLog(`✅ Signal: ${result.action} | Confidence: ${result.confidence}%`, result.action === "BUY_CALL" ? "bull" : result.action === "BUY_PUT" ? "bear" : "neutral");
      addLog(`🎯 Entry ₹${result.entry} | Target ₹${result.target} | SL ₹${result.stopLoss}`, "info");
      setTab("decision");
    } catch (e) {
      addLog(`❌ Analysis failed: ${e.message}`, "error");
    }
    setAnalyzing(false);
  }, [candles, last, prev, lastRSI, lastMACD, lastEMA9, lastEMA21, pattern, intervalCfg, priceChange, pctChange]);

  const actionColor = a => a === "BUY_CALL" ? C.bull : a === "BUY_PUT" ? C.bear : C.neutral;
  const actionEmoji = a => a === "BUY_CALL" ? "📈" : a === "BUY_PUT" ? "📉" : "⏸";
  const actionText  = a => a === "BUY_CALL" ? "BUY CALL" : a === "BUY_PUT" ? "BUY PUT" : "HOLD";

  const pill = (label, val, color) => (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 11 }}>
      <span style={{ color: C.muted }}>{label}: </span>
      <span style={{ color, fontWeight: 700 }}>{val ?? "—"}</span>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: 20, fontFamily: "'JetBrains Mono','Fira Code',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Rajdhani:wght@600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} }
        @keyframes glowGreen { 0%,100%{box-shadow:0 0 10px #00e67622}50%{box-shadow:0 0 26px #00e67666} }
        @keyframes glowRed   { 0%,100%{box-shadow:0 0 10px #ff174422}50%{box-shadow:0 0 26px #ff174466} }
        .btn:hover{filter:brightness(1.15)} .btn:active{transform:translateY(1px)}
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>
            NIFTY 50 <span style={{ color: C.accent }}>LIVE AI AGENT</span>
          </div>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1.5 }}>
            REAL DATA  · ^NSEI · OPTIONS SIGNAL ENGINE
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Interval selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {INTERVALS.map(iv => (
              <button key={iv.value} className="btn" onClick={() => { setIntervalCfg(iv); loadCandles(iv); }} style={{
                background: intervalCfg.value === iv.value ? C.accent + "33" : C.panel,
                border: `1px solid ${intervalCfg.value === iv.value ? C.accent : C.border}`,
                color: intervalCfg.value === iv.value ? C.accent : C.muted,
                borderRadius: 6, padding: "5px 10px", fontSize: 11, fontFamily: "inherit",
                cursor: "pointer", transition: "all 0.15s",
              }}>{iv.label}</button>
            ))}
          </div>

          {/* Price ticker */}
          {last && (
            <div style={{
              background: C.panel, border: `1px solid ${priceChange >= 0 ? C.bull + "44" : C.bear + "44"}`,
              borderRadius: 8, padding: "6px 14px", textAlign: "right",
            }}>
              <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 22, fontWeight: 700, color: priceChange >= 0 ? C.bull : C.bear }}>
                ₹{last.close.toLocaleString("en-IN")}
              </div>
              <div style={{ fontSize: 10, color: priceChange >= 0 ? C.bull : C.bear }}>
                {priceChange >= 0 ? "▲" : "▼"} {Math.abs(priceChange).toFixed(2)} ({pctChange}%)
              </div>
            </div>
          )}

          {/* Live toggle */}
          <button className="btn" onClick={() => setAutoRefresh(v => !v)} style={{
            background: autoRefresh ? C.bull + "22" : C.panel,
            border: `1px solid ${autoRefresh ? C.bull : C.border}`,
            color: autoRefresh ? C.bull : C.muted,
            borderRadius: 8, padding: "7px 14px", fontSize: 11, fontFamily: "inherit", cursor: "pointer",
          }}>
            {autoRefresh ? "⏹ LIVE ON" : "▶ LIVE"}
          </button>
        </div>
      </div>

      {/* ── Indicators pills ── */}
      {candles.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {pill("EMA9", lastEMA9?.toFixed(1), C.neutral)}
          {pill("EMA21", lastEMA21?.toFixed(1), C.accent)}
          {pill("RSI", lastRSI?.toFixed(1), lastRSI > 70 ? C.bear : lastRSI < 30 ? C.bull : C.text)}
          {pill("MACD", lastMACD > 0 ? "↑ Bull" : "↓ Bear", lastMACD > 0 ? C.bull : C.bear)}
          {pill("Pattern", pattern?.name || "None", pattern?.bias === "bullish" ? C.bull : pattern?.bias === "bearish" ? C.bear : C.muted)}
          {pill("Trend", lastEMA9 > lastEMA21 ? "Bullish ↑" : "Bearish ↓", lastEMA9 > lastEMA21 ? C.bull : C.bear)}
          {pill("Candles", candles.length, C.muted)}
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 0, marginBottom: 14, borderBottom: `1px solid ${C.border}` }}>
        {["chart", "decision", "log"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "transparent", border: "none",
            borderBottom: tab === t ? `2px solid ${C.accent}` : "2px solid transparent",
            color: tab === t ? C.accent : C.muted,
            padding: "7px 18px", fontSize: 11, fontFamily: "inherit",
            fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", cursor: "pointer",
          }}>{t}</button>
        ))}
      </div>

      {/* ── Chart tab ── */}
      {tab === "chart" && (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          {fetching && (
            <div style={{ textAlign: "center", padding: 60, color: C.muted }}>
              <div style={{ fontSize: 32, animation: "pulse 1s infinite" }}>📡</div>
              <div style={{ marginTop: 10, fontSize: 13 }}>Fetching live data from…</div>
            </div>
          )}
          {fetchError && !fetching && (
            <div style={{ textAlign: "center", padding: 40 }}>
              <div style={{ color: C.bear, fontSize: 13, marginBottom: 12 }}>{fetchError}</div>
              <button className="btn" onClick={() => loadCandles(intervalCfg)} style={{
                background: C.accent + "22", border: `1px solid ${C.accent}`, color: C.accent,
                borderRadius: 8, padding: "8px 20px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
              }}>↺ Retry</button>
            </div>
          )}
          {!fetching && candles.length > 0 && (
            <>
              <div style={{ padding: "10px 16px 4px", fontSize: 10, color: C.muted, display: "flex", gap: 16 }}>
                <span><span style={{ color: C.neutral }}>━</span> EMA9</span>
                <span><span style={{ color: C.accent }}>━</span> EMA21</span>
                <span><span style={{ color: C.bull }}>▲</span> BUY signal</span>
                <span><span style={{ color: C.bear }}>▼</span> SELL signal</span>
              </div>
              <div style={{ padding: "0 0 2px" }}>
                <CandleChart candles={candles} ema9={ema9} ema21={ema21} signals={signals} />
                <div style={{ height: 1, background: C.border }} />
                <RSIChart rsi={rsi} />
                <div style={{ height: 1, background: C.border }} />
                <MACDChart hist={macdHist} />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Decision tab ── */}
      {tab === "decision" && (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {!decision && !analyzing && (
            <div style={{ textAlign: "center", padding: 60, color: C.muted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
              <div>Load data then click <strong style={{ color: C.text }}>Analyse &amp; Decide</strong></div>
            </div>
          )}
          {analyzing && (
            <div style={{ textAlign: "center", padding: 60 }}>
              <div style={{ fontSize: 36, animation: "pulse 1s infinite" }}>⚡</div>
              <div style={{ color: C.accent, marginTop: 12, fontSize: 13 }}>Analysing live Nifty 50 data…</div>
            </div>
          )}
          {decision && !analyzing && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn 0.3s ease" }}>
              {/* Decision card */}
              <div style={{
                background: actionColor(decision.action) + "0d",
                border: `2px solid ${actionColor(decision.action)}44`,
                borderRadius: 14, padding: "22px 26px",
                animation: decision.action === "BUY_CALL" ? "glowGreen 2.5s infinite" : decision.action === "BUY_PUT" ? "glowRed 2.5s infinite" : "none",
                display: "flex", alignItems: "center", gap: 22,
              }}>
                <div style={{ fontSize: 56, lineHeight: 1, filter: `drop-shadow(0 0 12px ${actionColor(decision.action)})` }}>
                  {actionEmoji(decision.action)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 30, fontWeight: 700, color: actionColor(decision.action), letterSpacing: 2 }}>
                    {actionText(decision.action)}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                    Confidence <span style={{ color: actionColor(decision.action), fontWeight: 700 }}>{decision.confidence}%</span>
                    &nbsp;·&nbsp; Risk <span style={{ color: decision.risk === "LOW" ? C.bull : decision.risk === "HIGH" ? C.bear : C.neutral }}>{decision.risk}</span>
                    &nbsp;·&nbsp; {decision.timeframe}
                  </div>
                  <div style={{ fontSize: 12, color: C.text, marginTop: 10, lineHeight: 1.65, maxWidth: 560 }}>
                    {decision.reasoning}
                  </div>
                </div>
              </div>

              {/* Entry / Target / SL */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { label: "Entry Price", val: decision.entry, color: C.accent, sub: "" },
                  { label: "Target", val: decision.target, color: C.bull,
                    sub: decision.entry ? `+${((decision.target - decision.entry) / decision.entry * 100).toFixed(2)}%` : "" },
                  { label: "Stop Loss", val: decision.stopLoss, color: C.bear,
                    sub: decision.entry ? `-${((decision.entry - decision.stopLoss) / decision.entry * 100).toFixed(2)}%` : "" },
                ].map(({ label, val, color, sub }) => (
                  <div key={label} style={{ background: C.panel, border: `1px solid ${color}33`, borderRadius: 10, padding: "14px 18px" }}>
                    <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{label}</div>
                    <div style={{ color, fontSize: 22, fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>₹{val?.toFixed(2)}</div>
                    {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 3 }}>{sub}</div>}
                  </div>
                ))}
              </div>

              {/* Key signals */}
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>Key Signals</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {decision.keySignals?.map((s, i) => (
                    <div key={i} style={{
                      fontSize: 12, color: C.text, padding: "7px 10px",
                      background: C.bg, borderRadius: 6,
                      borderLeft: `2px solid ${actionColor(decision.action)}`,
                      lineHeight: 1.5,
                    }}>{s}</div>
                  ))}
                </div>
              </div>

              <div style={{ fontSize: 10, color: C.muted, textAlign: "center" }}>
                ⚠️ AI-generated signal for educational purposes only. Not financial advice. Always do your own research.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Log tab ── */}
      {tab === "log" && (
        <div ref={logRef} style={{
          background: C.panel, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: 14, height: 360, overflowY: "auto",
        }}>
          {log.length === 0
            ? <div style={{ color: C.muted, textAlign: "center", padding: 40 }}>No activity yet.</div>
            : log.map((l, i) => (
              <div key={i} style={{
                display: "flex", gap: 12, marginBottom: 5, fontSize: 11,
                color: l.type === "bull" ? C.bull : l.type === "bear" ? C.bear : l.type === "error" ? C.bear : l.type === "neutral" ? C.neutral : C.muted,
              }}>
                <span style={{ color: C.muted, flexShrink: 0 }}>{l.ts}</span>
                <span>{l.msg}</span>
              </div>
            ))
          }
        </div>
      )}

      {/* ── Action bar ── */}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn" onClick={analyze} disabled={analyzing || fetching || !candles.length} style={{
          flex: 1,
          background: analyzing || !candles.length ? C.muted : `linear-gradient(135deg, ${C.accent}, ${C.purple})`,
          border: "none", borderRadius: 10, padding: 13,
          fontSize: 13, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif",
          letterSpacing: 2, textTransform: "uppercase",
          color: "#fff", cursor: analyzing || !candles.length ? "not-allowed" : "pointer",
          transition: "filter 0.2s",
        }}>
          {analyzing ? "⚡ Analysing…" : "🧠 Analyse & Decide"}
        </button>
        <button className="btn" onClick={() => loadCandles(intervalCfg)} disabled={fetching} style={{
          background: C.panel, border: `1px solid ${C.border}`,
          color: fetching ? C.muted : C.text, borderRadius: 10,
          padding: "13px 18px", fontSize: 12, fontFamily: "inherit",
          cursor: fetching ? "not-allowed" : "pointer",
        }}>
          {fetching ? "…" : "↺ Refresh"}
        </button>
      </div>
    </div>
  );
}
