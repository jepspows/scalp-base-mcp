# Scalp MCP Plugin — Avantis Perps via Base MCP

> [!IMPORTANT]
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
>
> Before trading, you MUST complete Base MCP onboarding:
> 1. Call `get_wallets` (Detection)
> 2. Present wallet status and disclaimer (Onboarding)
>
> The user's wallet address is confirmed during Detection.

**Scalp MCP** is a real-time ETH momentum breakout scalper. It connects to Binance WebSocket for 1-minute candles, calculates VWAP + recent high/low levels, and generates LONG/SHORT signals when price breaks key levels. The agent executes via Avantis perps through Base MCP.

**Strategy**: Momentum breakout on 1m candles with trailing stop.

**Server**: Self-hosted (port 3002). WebSocket connection to Binance requires outbound internet.

---

## Strategy Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Leverage | 10x | Aggressive but survivable |
| Take Profit | +0.5% | $50 on $1,000 at 10x |
| Stop Loss | -0.25% | $25 on $1,000 at 10x |
| Trailing Stop | Activates at +0.3% | Locks in profit |
| Lookback | 5 candles | Breakout level = recent 5-candle high/low |
| VWAP Period | 15 candles | Volume-weighted average price |

**Risk/Reward**: 2:1 (0.5% TP vs 0.25% SL)

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
1. Current 1m candle close > recent 5-candle high
2. Previous candle close ≤ recent 5-candle high (breakout just happened)
3. Price > VWAP (uptrend confirmation)

### SHORT entry conditions (ALL must be true):
1. Current 1m candle close < recent 5-candle low
2. Previous candle close ≥ recent 5-candle low
3. Price < VWAP (downtrend confirmation)

### Exit conditions:
- TP hit → close position, take profit
- SL hit → close position, take loss
- Trailing stop: activates after 0.3% profit, trails 0.1% behind price

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
- **Trailing stops win**: Most profits come from runners that hit trail, not fixed TP.
- **Volume filter**: Low volume breakouts are noise. The VWAP confirmation filters fakeouts.
- **This is NOT HFT**: Signals fire on 1m candle closes. You have ~60 seconds to execute.
- **Gas is irrelevant**: $0.01-0.02 on Base L2. Position size $10K makes gas negligible.
- **24/7 operation**: Crypto never closes. Run this on Render for continuous monitoring.
