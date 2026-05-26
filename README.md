# Scalp Base MCP

**Real-time ETH momentum scalper for AI agents on Base.**

Binance WebSocket → 1m candles → VWAP breakout signals → Avantis perps via Base MCP.

## Strategy

| Parameter | Value |
|-----------|-------|
| Leverage | 10x |
| Take Profit | +0.5% |
| Stop Loss | -0.25% |
| Trailing Stop | Activates at +0.3% |
| Risk/Reward | 2:1 |

**Entry conditions**: Price breaks 5-candle high/low AND crosses VWAP.
**Exit**: TP hits, SL hits, or trailing stop catches the move.

## Quick Start

```bash
git clone https://github.com/jepspows/scalp-base-mcp.git
cd scalp-base-mcp/server
npm install && npm start
```

Server runs on port 3002. Connects to Binance WebSocket for live ETH/USDT data.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /v1/price` | Live ETH price + VWAP + levels |
| `GET /v1/signal` | Active scalp signal (LONG/SHORT/null) |
| `GET /v1/avantis-execute` | Avantis position execution plan |
| `GET /v1/history` | Signal history + PnL stats |

## Agent Usage

```
"Scalp ETH on Base. 10x leverage on Avantis. $1000 margin.
Execute signals automatically. Manage TP/SL/trailing stop."
```

Agent polls signal endpoint. On breakout: opens Avantis perp. Monitors exit. Closes on TP/SL/trail.

## License

MIT
