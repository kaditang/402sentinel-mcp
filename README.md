# 402sentinel-mcp

An MCP tool that lets your AI agent **check an x402 counterparty's risk before it
pays**. One tool, `assess_counterparty`: give it a payTo address, get back a
0–100 risk score + an `allow` / `review` / `block` decision, scored from on-chain
settlement behaviour on Base (address age, facilitator-aware payer diversity,
settlement maturity) with honest confidence/coverage.

It's a thin client for the hosted service at **https://402sentinel.com** — the
scoring model and facilitator-identification logic live server-side (closed); this
package only forwards the request and pays for it, so it's open source.

## Install

```sh
npm i -g @kaditang/402sentinel-mcp
```

## Configure

Add to your MCP client (Claude Desktop, Cursor, etc.):

```jsonc
{
  "mcpServers": {
    "402sentinel": {
      "command": "402sentinel-mcp",
      "env": {
        "CLIENT_PRIVATE_KEY": "0x...  // a Base wallet with USDC in its Circle Gateway balance"
      }
    }
  }
}
```

Each assessment costs **$0.01**, paid automatically in USDC via x402 (Circle
Gateway, gas-free on Base) from the configured wallet.

## Use

The agent calls it before authorizing a payment:

```
assess_counterparty({
  target: { payto_address: "0x..." },
  payment_context: { amount: 10, asset: "USDC" },
  policy: { block_at_score: 70, review_at_score: 40 }
})
→ { decision: "review", risk_score: 52, confidence: 0.41, coverage: {...}, dimensions: [...], recommendation: "..." }
```

- `block` → don't pay
- `review` → cap exposure / escrow
- `allow` → proceed

## Disclaimer

Algorithmic risk signal, informational only — **not advice, not an endorsement,
and not an accusation** about any party. Scores are probabilistic estimates from
limited public on-chain data and heuristics, and may misclassify. Do your own due
diligence; don't rely on it as your sole basis to pay or refuse. See
https://402sentinel.com/terms.

MIT.
