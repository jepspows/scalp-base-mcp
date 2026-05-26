# Scalp Bot Setup Guide

## What You Need

- Base Account (base.org — same login as Coinbase)
- AI agent with MCP support (Claude Desktop, ChatGPT, Codex, Cursor)
- $1,000 USDC on Base chain
- This repo

---

## Step 1: Start the Signal Server

```bash
cd C:\Users\D\scalp-base-mcp\server
npm start
```

You'll see:
```
Scalp Base MCP running on port 3002
Strategy: Momentum breakout | 15m candles | 10x leverage | TP: +2.0% | SL: -0.5%
Backtest: 10 months, 11/11 profitable months, 59% WR, +$38K on $1K
Waiting for Binance 15m candles (needs ~4 hours of data for VWAP)...
```

The server connects to Binance WebSocket. After 4 hours (16 candles), VWAP is populated and signals start firing.

Keep this terminal open. It runs forever.

---

## Step 2: Verify It's Working

In another terminal:
```bash
curl http://localhost:3002/health
# {"status":"ok","connected":true,"candles":5,"leverage":10,...}

curl http://localhost:3002/v1/price
# Shows live ETH price, VWAP, recent high/low

curl http://localhost:3002/v1/signal
# {"ok":true,"data":null,"message":"No active signal. Waiting for breakout."}
```

---

## Step 3: Configure Base MCP

Install Base MCP in your agent client. Follow https://docs.base.org/ai-agents

For Claude Desktop: add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "base": {
      "url": "https://mcp.base.org"
    }
  }
}
```

Then restart Claude. It will ask you to sign into your Base Account.

---

## Step 4: Load the Scalp Plugin

Tell your agent:

> Load the scalp trading plugin from C:\Users\D\scalp-base-mcp\plugin\scalp.md. The signal server is running at http://localhost:3002.

The agent now knows:
- How to poll for signals
- How to execute on Avantis via Base MCP
- TP/SL/trailing parameters

---

## Step 5: Fund Your Base Account

Send $1,000 USDC to your Base Account wallet on Base chain.

Verify:
> Check my USDC balance on Base.

---

## Step 6: Start Trading (Monitor Mode First)

> Start monitoring ETH scalp signals. Poll the signal server every 2 minutes. Alert me when a signal fires. Show entry, TP, SL, and direction. I'll decide whether to execute.

The agent will:
1. Poll `GET http://localhost:3002/v1/signal` every 2 min
2. When `data` is not null → alert you
3. You say "execute" → agent opens Avantis perp via Base MCP
4. Base Account opens → you click Approve → position is live
5. Agent continues polling signal endpoint for exit

---

## Step 7: Auto-Execute (Once Comfortable)

> Auto-execute all scalp signals. Open 10x Avantis perps immediately when signal fires. $1,000 margin. Manage TP at +2.0% and SL at -0.5% with trailing from +0.3%. Close when signal exits.

Agent now handles everything. You just check PnL once a day.

---

## Step 8: Check Performance

> Show me today's trading PnL and history.

Agent queries `GET http://localhost:3002/v1/history` and summarizes.

---

## 24/7 Operation (Deploy to Render)

To run without keeping your PC on:

1. Go to https://dashboard.render.com
2. Sign in with GitHub
3. Click New → Web Service
4. Connect repo `jepspows/scalp-base-mcp`
5. Render auto-detects `render.yaml`
6. Click Apply → deployed in 2 minutes

Server URL will be `https://scalp-base-mcp.onrender.com`

Update agent config to use this URL instead of localhost.

---

## Signal Example

When a signal fires, the agent sees:

```json
{
  "type": "LONG",
  "entry": 2077.52,
  "tp": 2119.07,
  "sl": 2067.13,
  "leverage": 10,
  "positionSize": "10000 (10x on $1000, +$200 win / -$50 loss)"
}
```

Agent proposes to Base MCP:
> Open 10x LONG ETH/USDC perp on Avantis. Entry: market. TP: $2119 (+2.0%). SL: $2067 (-0.5%). Trailing from +0.3%. Margin: $1000 USDC.

You click Approve in Base Account. Position is live.

---

## What NOT To Do

- Don't close the server while a position is open (agent can't see exits)
- Don't change leverage mid-trade
- Don't manually close the position unless emergency (confuses the trailing stop)
- Don't trade during FOMC/NFP/CPI news (2% SL won't save you from a 5% spike)
