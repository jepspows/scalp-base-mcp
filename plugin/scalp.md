# Scalp MCP Plugin — Avantis Perps via Base MCP

> [!IMPORTANT]
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
>
> Before trading, you MUST complete Base MCP onboarding:
> 1. Call `get_wallets` (Detection)
> 2. Present wallet status and disclaimer (Onboarding)
>
> The user's wallet address is confirmed during Detection.

**Scalp MCP v2** is a real-time ETH momentum breakout scalper with multi-filter signal engine. Polls Kraken REST for 15-minute candles, calculates VWAP + EMA trend + ATR volatility + volume profile, and generates LONG/SHORT signals only when ALL filters align. The agent executes via Avantis perps through Base MCP.

**Strategy**: Filtered momentum breakout on 15m candles with trailing stop, breakeven move, and risk circuit breakers.

**Server**: Self-hosted (port 3002). Polls Kraken REST API every 30s.

---

## Strategy Parameters (v2 Honed)

| Parameter | Value | Description |
|-----------|-------|-------------|
| Timeframe | 15m candles | Kraken ETH/USD |
| Leverage | 10x | $10,000 positions on $1,000 margin |
| Take Profit | +2.5% | +$250 per full win |
| Stop Loss (base) | -0.8% | Dynamic: max(0.8%, 1.5× ATR) |
| Trailing Stop | Activates at +1.2% | Locks runners with 0.4% buffer |
| Breakeven | SL→entry at +1.0% | Risk-free after small move |
| Lookback | 5 candles | Breakout from recent 5-bar high/low |
| VWAP Period | 15 candles | Volume-weighted average price |
| EMA Trend | 20-period | LONG only above EMA20, SHORT only below |
| ATR Period | 14 candles | Dynamic stop floor = 1.5× ATR |
| Volume Filter | ≥1.3× average | Skip low-volume fakeouts |
| Cooldown | 45m loss / 15m win | No revenge entries |
| Time Stop | 12 candles (3h) | Kill stale unresolved trades |
| Daily Loss Limit | -$300 | Circuit breaker for the day |

**Risk/Reward**: ~3:1 effective (2.5% TP vs 0.8% SL floor, tightened by trail/breakeven)

**Key v1→v2 fixes:**
- Trail used to activate at +0.3% with 0.1% buffer → choked winners at $27 avg
- No volume filter → took low-volume fakeouts
- No trend filter → traded against momentum
- No cooldown → revenge entries after losses
- Fixed 0.5% SL → wicked out on ETH volatility

---

## Read Endpoints

### Health check
```
GET {server}/health
```
Returns `{"status":"ok","connected":true,"candles":45,"leverage":10}`.

### Live price + indicators
```
GET {server}/v1/price
```
Response:
```json
{
  "ok": true,
  "data": {
    "price": 2076.79,
    "priceChange1m": "0.15",
    "vwap": 2075.32,
    "recentHigh": 2077.50,
    "recentLow": 2072.80,
    "volumeRatio": 1.2,
    "candle": { "open": 2075.10, "high": 2077.80, "low": 2074.90, "close": 2076.79, "volume": 85.4 },
    "timestamp": 1716840000000
  }
}
```

### Active signal
```
GET {server}/v1/signal
```
Returns the current active signal or null.

Response (signal active):
```json
{
  "ok": true,
  "data": {
    "type": "LONG",
    "entry": 2077.52,
    "tp": 2087.90,
    "sl": 2072.33,
    "vwap": 2075.32,
    "leverage": 10,
    "positionSize": "$10000 (10x on $1000)",
    "currentPrice": 2078.15,
    "unrealizedPnlPct": "3.03",
    "trailActive": false,
    "secondsAgo": 45
  }
}
```

### Avantis execution plan
```
GET {server}/v1/avantis-execute
```
Returns the prepared execution plan for Base MCP.

Response:
```json
{
  "ok": true,
  "data": {
    "action": "OPEN_PERP",
    "protocol": "Avantis",
    "chain": "base",
    "pair": "ETH/USDC",
    "direction": "LONG",
    "leverage": 10,
    "margin": "1000",
    "positionSize": "$10000",
    "entryPrice": 2077.52,
    "takeProfit": 2087.90,
    "stopLoss": 2072.33,
    "riskReward": "2.0:1",
    "agentPrompt": "Open 10x LONG ETH/USDC on Avantis via Base MCP..."
  }
}
```

### Signal history + PnL stats
```
GET {server}/v1/history?limit=50
```
Response includes `stats` object with win rate, total PnL, avg win/loss.

---

## Signal Logic (when the agent should act)

### LONG entry conditions (ALL must be true):
1. Current 15m candle close > recent 5-candle high (breakout)
2. Previous candle close ≤ recent 5-candle high (breakout just happened)
3. Price > VWAP (volume-weighted uptrend confirmation)
4. Price > EMA20 (trend filter — only trade with momentum)
5. Volume ≥ 1.3× 20-candle average (elevated volume breakout)
6. Cooldown elapsed (45 min after loss, 15 min after win)
7. Daily PnL > -$300 (circuit breaker)

### SHORT entry conditions (ALL must be true):
1. Current 15m candle close < recent 5-candle low (breakdown)
2. Previous candle close ≥ recent 5-candle low
3. Price < VWAP (downtrend confirmation)
4. Price < EMA20 (trend filter)
5. Volume ≥ 1.3× 20-candle average
6. Cooldown elapsed
7. Daily PnL > -$300

### Exit conditions:
- TP hit (+2.5%) → close position, take profit
- SL hit (-0.8% or 1.5× ATR, whichever is wider) → close position, take loss
- SL moves to breakeven after +1.0% profit (risk-free from that point)
- Trailing stop activates after +1.2% profit, trails 0.4% behind peak
- Time stop: exit after 12 candles (3 hours) if neither TP nor SL hit
- Daily loss limit: no new signals after -$300 daily PnL

---

## Agent Workflow

### Monitor mode
```
User: "Scalp ETH on Base. Watch for signals. Alert me immediately."
```

Agent polls `/v1/signal` every 5-10 seconds. When `data` is not null, alerts user with entry/TP/SL and asks if they want to execute.

### Auto-execute mode
```
User: "Auto-execute scalp signals. 10x on Avantis. $1000 margin."
```

Agent:
1. Polls `/v1/signal` every 5 seconds
2. On signal: calls `/v1/avantis-execute` for execution plan
3. Opens Avantis perp position via Base MCP
4. Polls `/v1/signal` for exit (TP/SL/trailing)
5. When signal closes: agent closes position via Base MCP

### Position management (after entry)
```
User: "Manage my open scalp position."
```

Agent:
1. Polls `/v1/signal` — if currentSignal has unrealizedPnlPct
2. If exit occurred: close position on Avantis
3. If signal still active: monitor trailActive, unrealizedPnl

---

## Base MCP Avantis Execution

The agent proposes to Base MCP:

```
"Open a 10x LONG ETH/USDC perpetual on Avantis.
 Margin: $1000 USDC from my Base Account.
 Entry: market price (~$2077).
 Set TP at $2087.90 and SL at $2072.33.
 Use trailing stop after +0.3% profit."
```

Base MCP prepares the Avantis perp open via its native plugin.

---

## Notes

- **10x is chosen deliberately**: 500x = instant liquidation. 10x survives 5% ETH swings.
- **Trailing stops win**: After +1.2% profit the trail kicks in with 0.4% buffer — wide enough to ride pullbacks, tight enough to lock gains.
- **Volume filter is critical**: Low-volume breakouts on 15m candles are usually fakeouts. Requiring 1.3× avg volume eliminates most false signals.
- **EMA trend filter**: Prevents counter-trend entries. The worst losses come from fading the dominant 15m trend.
- **Breakeven move**: Once a trade is +1.0% in profit, SL jumps to entry — worst case is scratch, best case is runner.
- **This is NOT HFT**: Signals fire on 15m candle closes via Kraken REST. You have ~30-60 seconds to execute.
- **Gas is irrelevant**: $0.01-0.02 on Base L2. Position size $10K makes gas negligible.
- **24/7 operation**: Crypto never closes. Run this on Render or VPS for continuous monitoring.
