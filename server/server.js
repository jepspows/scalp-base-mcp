const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());

// ─── Configuration ───────────────────────────────────────────────────────────
const BASE_CHAIN_ID = 8453;
const LEVERAGE = 10;           // 10x leverage
const TP_PCT = 0.004;          // 0.40% take profit (best backtest)
const SL_PCT = 0.0015;         // 0.15% stop loss (best backtest)
const TRAIL_PCT = 0.0025;      // Trail after 0.25% profit
const LOOKBACK_CANDLES = 5;    // Breakout lookback
const VWAP_PERIODS = 15;       // VWAP calculation window

// Binance WebSocket for 1m ETHUSDT klines
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/ethusdt@kline_1m';

// ─── State ───────────────────────────────────────────────────────────────────
let candles = [];              // {open,high,low,close,volume,time}
let currentSignal = null;      // active signal {type,entry,tp,sl,time,trailActive}
let signalHistory = [];        // past signals for backtesting
let vwap = 0;
let recentHigh = 0;
let recentLow = Infinity;
let volumeAlert = 0;

const MAX_CANDLES = 200;
const MAX_HISTORY = 200;

// ─── Calculations ────────────────────────────────────────────────────────────

function calcVWAP() {
  const window = candles.slice(-VWAP_PERIODS);
  if (window.length === 0) return 0;
  let cumulativePV = 0, cumulativeVol = 0;
  for (const c of window) {
    const typical = (c.high + c.low + c.close) / 3;
    cumulativePV += typical * c.volume;
    cumulativeVol += c.volume;
  }
  return cumulativeVol > 0 ? cumulativePV / cumulativeVol : 0;
}

function calcRecentHL() {
  const window = candles.slice(-LOOKBACK_CANDLES - 1, -1); // exclude current forming candle
  if (window.length === 0) return { high: 0, low: Infinity };
  return {
    high: Math.max(...window.map(c => c.high)),
    low: Math.min(...window.map(c => c.low)),
  };
}

function candleVolumeAvg() {
  const window = candles.slice(-20, -1);
  if (window.length === 0) return 0;
  return window.reduce((s, c) => s + c.volume, 0) / window.length;
}

// ─── Signal Engine ───────────────────────────────────────────────────────────

function checkSignals() {
  if (candles.length < VWAP_PERIODS + 2) return null;
  if (currentSignal) return null; // Only one signal at a time

  const price = candles[candles.length - 1].close;
  const prevPrice = candles[candles.length - 2].close;
  vwap = calcVWAP();
  const hl = calcRecentHL();
  recentHigh = hl.high;
  recentLow = hl.low;
  const avgVol = candleVolumeAvg();
  const lastVol = candles[candles.length - 1].volume;
  volumeAlert = avgVol > 0 ? lastVol / avgVol : 1;

  // LONG signal: price breaks above recent high AND above VWAP
  if (price > recentHigh && price > vwap && prevPrice <= recentHigh) {
    const signal = {
      type: 'LONG',
      entry: price,
      tp: price * (1 + TP_PCT),
      sl: price * (1 - SL_PCT),
      vwap,
      leverage: LEVERAGE,
      positionSize: `$${1000 * LEVERAGE} (${LEVERAGE}x on $1000)`,
      time: Date.now(),
      trailActive: false,
      trailPrice: 0,
      volumeRatio: volumeAlert,
    };
    currentSignal = signal;
    signalHistory.push({ ...signal, status: 'ACTIVE' });
    if (signalHistory.length > MAX_HISTORY) signalHistory.shift();
    return signal;
  }

  // SHORT signal: price breaks below recent low AND below VWAP
  if (price < recentLow && price < vwap && prevPrice >= recentLow) {
    const signal = {
      type: 'SHORT',
      entry: price,
      tp: price * (1 - TP_PCT),
      sl: price * (1 + SL_PCT),
      vwap,
      leverage: LEVERAGE,
      positionSize: `$${1000 * LEVERAGE} (${LEVERAGE}x on $1000)`,
      time: Date.now(),
      trailActive: false,
      trailPrice: 0,
      volumeRatio: volumeAlert,
    };
    currentSignal = signal;
    signalHistory.push({ ...signal, status: 'ACTIVE' });
    if (signalHistory.length > MAX_HISTORY) signalHistory.shift();
    return signal;
  }

  return null;
}

function updateTrailingStop(price) {
  if (!currentSignal) return null;

  // Check if trailing should activate
  if (!currentSignal.trailActive) {
    if (currentSignal.type === 'LONG' && price >= currentSignal.entry * (1 + TRAIL_PCT)) {
      currentSignal.trailActive = true;
      currentSignal.trailPrice = price;
    }
    if (currentSignal.type === 'SHORT' && price <= currentSignal.entry * (1 - TRAIL_PCT)) {
      currentSignal.trailActive = true;
      currentSignal.trailPrice = price;
    }
  }

  // Update trailing price
  if (currentSignal.trailActive) {
    if (currentSignal.type === 'LONG' && price > currentSignal.trailPrice) {
      currentSignal.trailPrice = price;
    }
    if (currentSignal.type === 'SHORT' && price < currentSignal.trailPrice) {
      currentSignal.trailPrice = price;
    }
  }

  // Check TP
  if (currentSignal.type === 'LONG' && price >= currentSignal.tp) {
    return closeSignal('TP', price);
  }
  if (currentSignal.type === 'SHORT' && price <= currentSignal.tp) {
    return closeSignal('TP', price);
  }

  // Check SL (or trailing SL)
  const effectiveSL = currentSignal.trailActive
    ? (currentSignal.type === 'LONG'
        ? currentSignal.trailPrice * (1 - 0.001) // 0.1% trail buffer
        : currentSignal.trailPrice * (1 + 0.001))
    : currentSignal.sl;

  if (currentSignal.type === 'LONG' && price <= effectiveSL) {
    return closeSignal(currentSignal.trailActive ? 'TRAILING_STOP' : 'STOP_LOSS', price);
  }
  if (currentSignal.type === 'SHORT' && price >= effectiveSL) {
    return closeSignal(currentSignal.trailActive ? 'TRAILING_STOP' : 'STOP_LOSS', price);
  }

  return null;
}

function closeSignal(reason, price) {
  const entry = currentSignal.entry;
  const pnlPct = currentSignal.type === 'LONG'
    ? ((price - entry) / entry * 100)
    : ((entry - price) / entry * 100);
  const pnlUsd = (pnlPct / 100 * 1000 * LEVERAGE);

  const closed = {
    ...currentSignal,
    status: 'CLOSED',
    closeReason: reason,
    closePrice: price,
    pnlPct: pnlPct.toFixed(3),
    pnlUsd: pnlUsd.toFixed(2),
    closedAt: Date.now(),
    durationSeconds: Math.round((Date.now() - currentSignal.time) / 1000),
  };

  // Update in history
  const idx = signalHistory.findIndex(s => s.status === 'ACTIVE');
  if (idx >= 0) signalHistory[idx] = closed;

  currentSignal = null;
  return closed;
}

// ─── Binance WebSocket ───────────────────────────────────────────────────────

function connectBinance() {
  const ws = new WebSocket(BINANCE_WS);

  ws.on('open', () => {
    console.log('Connected to Binance WebSocket (ETH/USDT 1m klines)');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.k) return;

      const k = msg.k;
      const candle = {
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        time: k.t,
        isClosed: k.x,
      };

      // Update or add candle
      if (candles.length > 0 && candles[candles.length - 1].time === candle.time) {
        candles[candles.length - 1] = candle;
      } else {
        candles.push(candle);
        if (candles.length > MAX_CANDLES) candles.shift();
      }

      // Only check signals on candle close
      if (k.x) {
        // Update trailing stop first (on every close)
        const closed = updateTrailingStop(candle.close);
        if (closed && global.onSignalClose) global.onSignalClose(closed);

        // Check for new signals
        if (!currentSignal) {
          const signal = checkSignals();
          if (signal && global.onNewSignal) global.onNewSignal(signal);
        }
      } else {
        // Even on partial candles, check TP/SL
        const closed = updateTrailingStop(candle.close);
        if (closed && global.onSignalClose) global.onSignalClose(closed);
      }
    } catch (e) {
      // parse error
    }
  });

  ws.on('close', () => {
    console.log('Binance WS disconnected. Reconnecting in 5s...');
    setTimeout(connectBinance, 5000);
  });

  ws.on('error', (err) => {
    console.error('Binance WS error:', err.message);
  });

  return ws;
}

// ─── Callbacks ───────────────────────────────────────────────────────────────
global.onNewSignal = (signal) => {
  console.log(`\n🔥 ${signal.type} SIGNAL | Entry: $${signal.entry.toFixed(2)} | TP: $${signal.tp.toFixed(2)} | SL: $${signal.sl.toFixed(2)}`);
  console.log(`   VWAP: $${signal.vwap.toFixed(2)} | Volume: ${signal.volumeRatio.toFixed(1)}x avg | Leverage: ${signal.leverage}x`);
};

global.onSignalClose = (closed) => {
  const emoji = closed.pnlUsd > 0 ? '✅' : '❌';
  console.log(`\n${emoji} ${closed.type} CLOSED (${closed.closeReason}) | PnL: ${closed.pnlPct}% | $${closed.pnlUsd} | ${closed.durationSeconds}s`);
};

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: true,
    candles: candles.length,
    leverage: LEVERAGE,
    tpPct: TP_PCT,
    slPct: SL_PCT,
  });
});

// GET /v1/price — Current price + indicators
app.get('/v1/price', (req, res) => {
  if (candles.length === 0) {
    return res.json({ ok: false, error: 'No data yet. Wait for candles to load.' });
  }
  const last = candles[candles.length - 1];
  res.json({
    ok: true,
    data: {
      price: last.close,
      priceChange1m: candles.length > 1
        ? ((last.close - candles[candles.length - 2].close) / candles[candles.length - 2].close * 100).toFixed(3)
        : '0',
      vwap: vwap.toFixed(2),
      recentHigh: recentHigh.toFixed(2),
      recentLow: recentLow === Infinity ? 'N/A' : recentLow.toFixed(2),
      volumeRatio: volumeAlert.toFixed(1),
      candle: last,
      timestamp: Date.now(),
    },
  });
});

// GET /v1/signal — Current active signal or null
app.get('/v1/signal', (req, res) => {
  if (!currentSignal) {
    return res.json({
      ok: true,
      data: null,
      message: 'No active signal. Waiting for breakout.',
    });
  }

  const price = candles.length > 0 ? candles[candles.length - 1].close : currentSignal.entry;
  const unrealizedPnl = currentSignal.type === 'LONG'
    ? ((price - currentSignal.entry) / currentSignal.entry * 100 * LEVERAGE)
    : ((currentSignal.entry - price) / currentSignal.entry * 100 * LEVERAGE);

  res.json({
    ok: true,
    data: {
      ...currentSignal,
      currentPrice: price,
      unrealizedPnlPct: unrealizedPnl.toFixed(2),
      trailActive: currentSignal.trailActive,
      trailPrice: currentSignal.trailPrice || null,
      secondsAgo: Math.round((Date.now() - currentSignal.time) / 1000),
    },
  });
});

// GET /v1/history — Signal history with PnL
app.get('/v1/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;

  const stats = {
    total: signalHistory.length,
    wins: signalHistory.filter(s => s.status === 'CLOSED' && parseFloat(s.pnlUsd) > 0).length,
    losses: signalHistory.filter(s => s.status === 'CLOSED' && parseFloat(s.pnlUsd) <= 0).length,
    totalPnl: signalHistory
      .filter(s => s.pnlUsd)
      .reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0).toFixed(2),
    avgWin: signalHistory.filter(s => parseFloat(s.pnlUsd) > 0).length > 0
      ? (signalHistory.filter(s => parseFloat(s.pnlUsd) > 0).reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0) /
         signalHistory.filter(s => parseFloat(s.pnlUsd) > 0).length).toFixed(2)
      : '0',
    winRate: signalHistory.filter(s => s.status === 'CLOSED').length > 0
      ? (signalHistory.filter(s => s.status === 'CLOSED' && parseFloat(s.pnlUsd) > 0).length /
         signalHistory.filter(s => s.status === 'CLOSED').length * 100).toFixed(1)
      : '0',
  };

  res.json({
    ok: true,
    data: signalHistory.slice(-limit),
    stats,
  });
});

// GET /v1/avantis-execute — Prepared execution plan for Base MCP
app.get('/v1/avantis-execute', (req, res) => {
  if (!currentSignal) {
    return res.json({ ok: false, error: 'No active signal', message: 'Wait for a breakout signal.' });
  }

  const isLong = currentSignal.type === 'LONG';

  res.json({
    ok: true,
    data: {
      action: 'OPEN_PERP',
      protocol: 'Avantis',
      chain: 'base',
      pair: 'ETH/USDC',
      direction: currentSignal.type,
      leverage: LEVERAGE,
      margin: '1000',
      positionSize: `$${1000 * LEVERAGE}`,
      entryPrice: currentSignal.entry,
      takeProfit: currentSignal.tp,
      stopLoss: currentSignal.sl,
      trailActive: currentSignal.trailActive,
      riskReward: `${((TP_PCT / SL_PCT)).toFixed(1)}:1`,
      // Agent prompt for Base MCP
      agentPrompt: isLong
        ? `Open ${LEVERAGE}x LONG ETH/USDC on Avantis via Base MCP. Entry: $${currentSignal.entry.toFixed(2)}. TP: $${currentSignal.tp.toFixed(2)} (+${(TP_PCT*100).toFixed(1)}%). SL: $${currentSignal.sl.toFixed(2)} (-${(SL_PCT*100).toFixed(1)}%). Margin: $1000. Position size: $${1000 * LEVERAGE}. Trailing stop activates at +${(TRAIL_PCT*100).toFixed(1)}%.`
        : `Open ${LEVERAGE}x SHORT ETH/USDC on Avantis via Base MCP. Entry: $${currentSignal.entry.toFixed(2)}. TP: $${currentSignal.tp.toFixed(2)} (+${(TP_PCT*100).toFixed(1)}%). SL: $${currentSignal.sl.toFixed(2)} (-${(SL_PCT*100).toFixed(1)}%). Margin: $1000. Position size: $${1000 * LEVERAGE}. Trailing stop activates at +${(TRAIL_PCT*100).toFixed(1)}%.`,
      config: {
        leverage: LEVERAGE,
        tpPct: TP_PCT,
        slPct: SL_PCT,
        trailPct: TRAIL_PCT,
        pair: 'ETH/USDC',
        chain: 'Base (8453)',
        protocol: 'Avantis',
      },
    },
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Scalp Base MCP running on port ${PORT}`);
  console.log(`Strategy: Momentum breakout | ${LEVERAGE}x leverage | TP: +${(TP_PCT*100).toFixed(1)}% | SL: -${(SL_PCT*100).toFixed(1)}%`);
  console.log(`Trailing stop: activates after +${(TRAIL_PCT*100).toFixed(1)}%`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET /v1/price            — Live ETH price + indicators');
  console.log('  GET /v1/signal           — Active scalping signal');
  console.log('  GET /v1/avantis-execute  — Avantis execution plan');
  console.log('  GET /v1/history          — Signal PnL history');
  console.log('');
  console.log('Waiting for Binance candles...');
  connectBinance();
});
