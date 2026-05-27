const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const BASE_CHAIN_ID = 8453;
const LEVERAGE = 10;

// Entry / exit thresholds
const TP_PCT        = 0.025;   // Take profit: +2.5% price move (+$250 on $1K/10x)
const SL_PCT        = 0.008;   // Stop loss:   -0.8% price move (-$80 on $1K/10x)
const TRAIL_PCT     = 0.012;   // Trail activates after +1.2%
const TRAIL_BUFFER  = 0.004;   // Trail closes at peak -0.4% (was 0.1% — noise)
const BE_PCT        = 0.010;   // Move SL to breakeven after +1.0%

// Signal filters
const LOOKBACK_CANDLES   = 5;
const VWAP_PERIODS       = 15;
const EMA_PERIOD         = 20;    // Trend: LONG only above EMA20, SHORT only below
const ATR_PERIOD         = 14;    // Dynamic SL floor
const ATR_SL_MULT        = 1.5;   // SL floor = ATR × 1.5
const VOLUME_MIN_RATIO   = 1.3;   // Require ≥1.3× avg volume for entry

// Risk management
const COOLDOWN_LOSS_MS   = 45 * 60 * 1000;  // 45 min after loss
const COOLDOWN_WIN_MS    = 15 * 60 * 1000;  // 15 min after win
const TIME_STOP_CANDLES  = 12;              // Exit after 12 candles (3h)
const MAX_DAILY_LOSS     = 300;             // Stop for the day after -$300

// Data source
const KRAKEN_API = 'https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=15';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
let candles        = [];   // {open,high,low,close,volume,time}
let currentSignal  = null; // active signal
let signalHistory  = [];   // closed + active signals
let vwap           = 0;
let ema            = 0;
let atr            = 0;
let recentHigh     = 0;
let recentLow      = Infinity;
let volumeAlert    = 0;

// Cooldown / daily loss
let lastCloseTime  = 0;
let lastCloseWasLoss = false;
let dailyPnl       = 0;
let dailyDate      = '';

const MAX_CANDLES  = 200;
const MAX_HISTORY  = 500;

// ═══════════════════════════════════════════════════════════════════════════════
// CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

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

function calcEMA(period) {
  if (candles.length < period) return candles.length > 0 ? candles[candles.length - 1].close : 0;
  const k = 2 / (period + 1);
  let emaVal = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period; // SMA seed
  for (let i = period; i < candles.length; i++) {
    emaVal = candles[i].close * k + emaVal * (1 - k);
  }
  return emaVal;
}

function calcATR(period) {
  if (candles.length < period + 1) {
    // Fallback: use SL_PCT-based value
    return candles.length > 0 ? candles[candles.length - 1].close * SL_PCT : 0;
  }
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

function calcRecentHL() {
  const window = candles.slice(-LOOKBACK_CANDLES - 1, -1); // exclude current candle
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

function updateIndicators() {
  vwap = calcVWAP();
  ema = calcEMA(EMA_PERIOD);
  atr = calcATR(ATR_PERIOD);
  const hl = calcRecentHL();
  recentHigh = hl.high;
  recentLow = hl.low;
  const avgVol = candleVolumeAvg();
  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  volumeAlert = avgVol > 0 && last ? last.volume / avgVol : 1;
}

function resetDailyPnl() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyDate !== today) {
    dailyPnl = 0;
    dailyDate = today;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function checkSignals() {
  if (candles.length < Math.max(VWAP_PERIODS, EMA_PERIOD, ATR_PERIOD) + 2) return null;
  if (currentSignal) return null;

  // Daily loss circuit breaker
  resetDailyPnl();
  if (dailyPnl <= -MAX_DAILY_LOSS) return null;

  // Cooldown after closed trade
  if (lastCloseTime > 0) {
    const cooldown = lastCloseWasLoss ? COOLDOWN_LOSS_MS : COOLDOWN_WIN_MS;
    if (Date.now() - lastCloseTime < cooldown) return null;
  }

  const price     = candles[candles.length - 1].close;
  const prevPrice = candles[candles.length - 2].close;

  // Refresh indicators
  vwap = calcVWAP();
  ema = calcEMA(EMA_PERIOD);
  atr = calcATR(ATR_PERIOD);
  const hl = calcRecentHL();
  recentHigh = hl.high;
  recentLow = hl.low;
  const avgVol = candleVolumeAvg();
  const lastVol = candles[candles.length - 1].volume;
  volumeAlert = avgVol > 0 ? lastVol / avgVol : 1;

  // Volume filter — skip low-volume breakouts
  if (volumeAlert < VOLUME_MIN_RATIO) return null;

  // Dynamic SL floor from ATR
  const atrSl = atr * ATR_SL_MULT;
  const priceSlPct = price * SL_PCT;
  const effectiveSl = Math.max(atrSl, priceSlPct);

  // ── LONG ──────────────────────────────────────────────────────────────
  const brokeHigh  = price > recentHigh && prevPrice <= recentHigh;
  const aboveVwap  = price > vwap;
  const aboveEma   = price > ema;   // trend filter

  if (brokeHigh && aboveVwap && aboveEma) {
    const slPrice = price - effectiveSl;
    const signal = {
      type: 'LONG',
      entry: price,
      tp: price * (1 + TP_PCT),
      sl: slPrice,
      slPctUsed: ((effectiveSl / price) * 100).toFixed(2),
      vwap,
      ema,
      atr,
      leverage: LEVERAGE,
      positionSize: `${1000 * LEVERAGE} (${LEVERAGE}x on $1000)` + 
        ` | TP +$${(1000*LEVERAGE*TP_PCT).toFixed(0)} / SL -$${(1000*LEVERAGE*(effectiveSl/price)).toFixed(0)}`,
      time: Date.now(),
      trailActive: false,
      trailPrice: 0,
      breakevenMoved: false,
      entryCandleIndex: candles.length - 1,
      volumeRatio: volumeAlert,
    };
    currentSignal = signal;
    signalHistory.push({ ...signal, status: 'ACTIVE' });
    if (signalHistory.length > MAX_HISTORY) signalHistory.shift();
    return signal;
  }

  // ── SHORT ─────────────────────────────────────────────────────────────
  const brokeLow   = price < recentLow && prevPrice >= recentLow;
  const belowVwap  = price < vwap;
  const belowEma   = price < ema;

  if (brokeLow && belowVwap && belowEma) {
    const slPrice = price + effectiveSl;
    const signal = {
      type: 'SHORT',
      entry: price,
      tp: price * (1 - TP_PCT),
      sl: slPrice,
      slPctUsed: ((effectiveSl / price) * 100).toFixed(2),
      vwap,
      ema,
      atr,
      leverage: LEVERAGE,
      positionSize: `${1000 * LEVERAGE} (${LEVERAGE}x on $1000)` +
        ` | TP +$${(1000*LEVERAGE*TP_PCT).toFixed(0)} / SL -$${(1000*LEVERAGE*(effectiveSl/price)).toFixed(0)}`,
      time: Date.now(),
      trailActive: false,
      trailPrice: 0,
      breakevenMoved: false,
      entryCandleIndex: candles.length - 1,
      volumeRatio: volumeAlert,
    };
    currentSignal = signal;
    signalHistory.push({ ...signal, status: 'ACTIVE' });
    if (signalHistory.length > MAX_HISTORY) signalHistory.shift();
    return signal;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function updateTrailingStop(price) {
  if (!currentSignal) return null;

  const isLong = currentSignal.type === 'LONG';

  // 1. Check TP first
  if (isLong && price >= currentSignal.tp) return closeSignal('TP', price);
  if (!isLong && price <= currentSignal.tp) return closeSignal('TP', price);

  // 2. Move SL to breakeven after BE_PCT profit
  if (!currentSignal.breakevenMoved) {
    const beTrigger = isLong
      ? price >= currentSignal.entry * (1 + BE_PCT)
      : price <= currentSignal.entry * (1 - BE_PCT);
    if (beTrigger) {
      currentSignal.sl = currentSignal.entry;
      currentSignal.breakevenMoved = true;
    }
  }

  // 3. Activate trailing stop
  if (!currentSignal.trailActive) {
    const trailTrigger = isLong
      ? price >= currentSignal.entry * (1 + TRAIL_PCT)
      : price <= currentSignal.entry * (1 - TRAIL_PCT);
    if (trailTrigger) {
      currentSignal.trailActive = true;
      currentSignal.trailPrice = price;
    }
  }

  // 4. Update trailing price (only moves in profit direction)
  if (currentSignal.trailActive) {
    if (isLong && price > currentSignal.trailPrice) {
      currentSignal.trailPrice = price;
    }
    if (!isLong && price < currentSignal.trailPrice) {
      currentSignal.trailPrice = price;
    }
  }

  // 5. Effective stop level
  let effectiveSL;
  if (currentSignal.trailActive) {
    effectiveSL = isLong
      ? currentSignal.trailPrice * (1 - TRAIL_BUFFER)
      : currentSignal.trailPrice * (1 + TRAIL_BUFFER);
  } else {
    effectiveSL = currentSignal.sl; // may have been moved to breakeven
  }

  // Ensure trailing SL never worse than original SL
  if (isLong) {
    effectiveSL = Math.max(effectiveSL, currentSignal.sl);
  } else {
    effectiveSL = Math.min(effectiveSL, currentSignal.sl);
  }

  // 6. Check SL hit
  if (isLong && price <= effectiveSL) {
    return closeSignal(currentSignal.trailActive ? 'TRAILING_STOP' : 'STOP_LOSS', price);
  }
  if (!isLong && price >= effectiveSL) {
    return closeSignal(currentSignal.trailActive ? 'TRAILING_STOP' : 'STOP_LOSS', price);
  }

  // 7. Time stop — exit if held too long
  const candlesHeld = candles.length - currentSignal.entryCandleIndex;
  if (candlesHeld >= TIME_STOP_CANDLES) {
    return closeSignal('TIME_STOP', price);
  }

  return null;
}

function closeSignal(reason, price) {
  const isLong = currentSignal.type === 'LONG';
  const entry = currentSignal.entry;
  const pnlPct = isLong
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

  // Track for cooldown
  lastCloseTime = Date.now();
  lastCloseWasLoss = pnlUsd <= 0;

  // Daily PnL tracking
  resetDailyPnl();
  dailyPnl += pnlUsd;

  currentSignal = null;
  return closed;
}

let lastCandleTime = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// DATA POLLING (Kraken REST)
// ═══════════════════════════════════════════════════════════════════════════════

let initialLoadDone = false;

async function fetchCandles() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(KRAKEN_API, { signal: controller.signal });
    clearTimeout(timeout);

    const data = await res.json();
    if (!data.result || data.error?.length > 0) {
      console.error('Kraken API error:', JSON.stringify(data.error));
      return;
    }

    const raw = data.result.XETHZUSD;
    if (!Array.isArray(raw)) return;

    const newCandles = raw.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[6]),
      time: k[0] * 1000,
    })).sort((a, b) => a.time - b.time);

    if (!initialLoadDone) {
      candles = newCandles.slice(-MAX_CANDLES);
      lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : 0;
      initialLoadDone = true;
      updateIndicators();
      return;
    }

    const freshCandles = newCandles.filter(c => c.time > lastCandleTime);

    for (const nc of freshCandles) {
      candles.push(nc);
      if (candles.length > MAX_CANDLES) candles.shift();
      lastCandleTime = nc.time;

      // Check exit on each new candle close
      const closed = updateTrailingStop(nc.close);
      if (closed && global.onSignalClose) global.onSignalClose(closed);

      // Check entry if no active signal
      if (!currentSignal) {
        const signal = checkSignals();
        if (signal && global.onNewSignal) global.onNewSignal(signal);
      }
    }

    updateIndicators();

    // Also run trailing check on latest price between candles
    if (freshCandles.length === 0 && newCandles.length > 0) {
      updateTrailingStop(newCandles[newCandles.length - 1].close);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('Kraken API timeout (15s)');
    } else {
      console.error('Kraken API error:', e.message);
    }
  }
}

async function pollLoop() {
  console.log('Loading initial candles...');
  await fetchCandles();
  console.log('Loaded ' + candles.length + ' candles');
  while (true) {
    await new Promise(r => setTimeout(r, 30000));
    process.stdout.write('.');
    await fetchCandles();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLBACKS
// ═══════════════════════════════════════════════════════════════════════════════

global.onNewSignal = (signal) => {
  console.log(`\n🔥 ${signal.type} SIGNAL | Entry: $${signal.entry.toFixed(2)} | TP: $${signal.tp.toFixed(2)} | SL: $${signal.sl.toFixed(2)}`);
  console.log(`   VWAP: $${signal.vwap.toFixed(2)} | EMA: $${signal.ema.toFixed(2)} | ATR: $${signal.atr.toFixed(2)}`);
  console.log(`   Volume: ${signal.volumeRatio.toFixed(1)}x avg | SL: ${signal.slPctUsed}% | Leverage: ${signal.leverage}x`);
  console.log(`   Filters: Vol≥${VOLUME_MIN_RATIO}x ✓ | VWAP ✓ | EMA trend ✓`);
};

global.onSignalClose = (closed) => {
  const emoji = parseFloat(closed.pnlUsd) > 0 ? '✅' : '❌';
  console.log(`\n${emoji} ${closed.type} CLOSED (${closed.closeReason}) | PnL: ${closed.pnlPct}% | $${closed.pnlUsd} | ${closed.durationSeconds}s`);
  if (closed.breakevenMoved) console.log('   🛡️  SL was moved to breakeven');
  if (closed.trailActive) console.log(`   📈 Trail was active (peak: $${closed.trailPrice?.toFixed(2)})`);
  resetDailyPnl();
  console.log(`   Daily PnL: $${dailyPnl.toFixed(2)} / -$${MAX_DAILY_LOSS} limit`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: true,
    candles: candles.length,
    leverage: LEVERAGE,
    tpPct: TP_PCT,
    slPct: SL_PCT,
    trailPct: TRAIL_PCT,
    trailBuffer: TRAIL_BUFFER,
    bePct: BE_PCT,
    volumeMinRatio: VOLUME_MIN_RATIO,
    emaPeriod: EMA_PERIOD,
    atrPeriod: ATR_PERIOD,
    dailyPnl: dailyPnl.toFixed(2),
    dailyLossLimit: MAX_DAILY_LOSS,
    cooldownActive: lastCloseTime > 0 && (Date.now() - lastCloseTime) < (lastCloseWasLoss ? COOLDOWN_LOSS_MS : COOLDOWN_WIN_MS),
  });
});

app.get('/v1/config', (req, res) => {
  res.json({
    ok: true,
    data: {
      leverage: LEVERAGE,
      tpPct: TP_PCT,
      slPct: SL_PCT,
      trailPct: TRAIL_PCT,
      trailBuffer: TRAIL_BUFFER,
      bePct: BE_PCT,
      lookbackCandles: LOOKBACK_CANDLES,
      vwapPeriods: VWAP_PERIODS,
      emaPeriod: EMA_PERIOD,
      atrPeriod: ATR_PERIOD,
      atrSlMult: ATR_SL_MULT,
      volumeMinRatio: VOLUME_MIN_RATIO,
      cooldownLossMin: COOLDOWN_LOSS_MS / 60000,
      cooldownWinMin: COOLDOWN_WIN_MS / 60000,
      timeStopCandles: TIME_STOP_CANDLES,
      maxDailyLoss: MAX_DAILY_LOSS,
      pair: 'ETH/USD',
      interval: '15m',
      exchange: 'Kraken',
    },
  });
});

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
      ema: ema.toFixed(2),
      atr: atr.toFixed(2),
      recentHigh: recentHigh.toFixed(2),
      recentLow: recentLow === Infinity ? 'N/A' : recentLow.toFixed(2),
      volumeRatio: volumeAlert.toFixed(1),
      candle: last,
      timestamp: Date.now(),
    },
  });
});

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
      breakevenMoved: currentSignal.breakevenMoved,
      secondsAgo: Math.round((Date.now() - currentSignal.time) / 1000),
      candlesHeld: candles.length - currentSignal.entryCandleIndex,
    },
  });
});

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
      breakevenMoved: currentSignal.breakevenMoved,
      riskReward: `${(TP_PCT / parseFloat(currentSignal.slPctUsed || (currentSignal.sl / currentSignal.entry * 100))).toFixed(1)}:1`,
      agentPrompt: isLong
        ? `Open ${LEVERAGE}x LONG ETH/USDC on Avantis via Base MCP. Entry: $${currentSignal.entry.toFixed(2)}. TP: $${currentSignal.tp.toFixed(2)} (+${(TP_PCT*100).toFixed(1)}%). SL: $${currentSignal.sl.toFixed(2)}. Margin: $1000. Position size: $${1000 * LEVERAGE}. Trailing stop activates at +${(TRAIL_PCT*100).toFixed(1)}%. SL moves to breakeven at +${(BE_PCT*100).toFixed(1)}%.`
        : `Open ${LEVERAGE}x SHORT ETH/USDC on Avantis via Base MCP. Entry: $${currentSignal.entry.toFixed(2)}. TP: $${currentSignal.tp.toFixed(2)} (+${(TP_PCT*100).toFixed(1)}%). SL: $${currentSignal.sl.toFixed(2)}. Margin: $1000. Position size: $${1000 * LEVERAGE}. Trailing stop activates at +${(TRAIL_PCT*100).toFixed(1)}%. SL moves to breakeven at +${(BE_PCT*100).toFixed(1)}%.`,
      config: {
        leverage: LEVERAGE,
        tpPct: TP_PCT,
        slPct: SL_PCT,
        trailPct: TRAIL_PCT,
        trailBuffer: TRAIL_BUFFER,
        bePct: BE_PCT,
        pair: 'ETH/USDC',
        chain: 'Base (8453)',
        protocol: 'Avantis',
      },
    },
  });
});

app.get('/v1/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const closedTrades = signalHistory.filter(s => s.status === 'CLOSED');
  const wins  = closedTrades.filter(s => parseFloat(s.pnlUsd) > 0);
  const losses = closedTrades.filter(s => parseFloat(s.pnlUsd) <= 0);

  const totalPnl = closedTrades.reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0);
  const avgWin  = wins.length > 0
    ? wins.reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0) / losses.length
    : 0;
  const winRate = closedTrades.length > 0
    ? (wins.length / closedTrades.length * 100)
    : 0;
  const grossProfit = wins.reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0);
  const grossLoss   = Math.abs(losses.reduce((s, sig) => s + parseFloat(sig.pnlUsd), 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
  const largestWin  = wins.length > 0 ? Math.max(...wins.map(s => parseFloat(s.pnlUsd))) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses.map(s => parseFloat(s.pnlUsd))) : 0;

  const stats = {
    total: signalHistory.length,
    closed: closedTrades.length,
    active: signalHistory.filter(s => s.status === 'ACTIVE').length,
    wins: wins.length,
    losses: losses.length,
    totalPnl: totalPnl.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    winRate: winRate.toFixed(1),
    profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
    largestWin: largestWin.toFixed(2),
    largestLoss: largestLoss.toFixed(2),
    expectancy: closedTrades.length > 0
      ? ((winRate / 100 * avgWin) - ((1 - winRate / 100) * Math.abs(avgLoss))).toFixed(2)
      : '0',
    dailyPnl: dailyPnl.toFixed(2),
    dailyLossLimit: MAX_DAILY_LOSS,
  };

  res.json({
    ok: true,
    data: signalHistory.slice(-limit),
    stats,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  SCALP BASE MCP  v2.0  —  HONED EDITION                     ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Port:     ${PORT}                                               ║`);
  console.log(`║  Pair:     ETH/USD  |  15m candles  |  ${LEVERAGE}x leverage          ║`);
  console.log(`║  TP:       +${(TP_PCT*100).toFixed(1)}%   |  SL: ${(SL_PCT*100).toFixed(1)}% (min)    |  ATR SL: ${ATR_SL_MULT}x ATR    ║`);
  console.log(`║  Trail:    +${(TRAIL_PCT*100).toFixed(1)}%  |  Bfr: ${(TRAIL_BUFFER*100).toFixed(1)}%     |  BE: +${(BE_PCT*100).toFixed(1)}%           ║`);
  console.log(`║  Vol min:  ${VOLUME_MIN_RATIO}x avg  |  EMA: ${EMA_PERIOD}      |  Cooldown: ${COOLDOWN_LOSS_MS/60000}m/${COOLDOWN_WIN_MS/60000}m      ║`);
  console.log(`║  TimeStop: ${TIME_STOP_CANDLES}candles |  Daily lim: $${MAX_DAILY_LOSS}   |  ATR: ${ATR_PERIOD} candles       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET /health             — Status + config summary');
  console.log('  GET /v1/config          — Full strategy parameters');
  console.log('  GET /v1/price           — Live price + indicators (VWAP, EMA, ATR)');
  console.log('  GET /v1/signal          — Active signal or null');
  console.log('  GET /v1/avantis-execute — Avantis execution plan');
  console.log('  GET /v1/history         — Trade history + stats (PF, expectancy, etc.)');
  console.log('');
  console.log('Polling Kraken API (15m candles, 30s intervals)...');
  pollLoop();
});
