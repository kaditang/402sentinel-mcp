# 402sentinel-mcp

MCP tools that let your AI agent **check an x402 counterparty's risk before it
pays** — and turn that risk into an enforceable wallet spending policy. Give it a
payTo address, get back a 0–100 risk score + an `allow` / `review` / `block`
decision, scored from on-chain settlement behaviour on Base (address age,
facilitator-aware payer diversity, settlement maturity) + a delivery-outcome
flywheel, with honest confidence/coverage.

Tools — vet the **seller**:
- `assess_counterparty` ($0.002) — risk score + decision + a ready-to-apply `recommended_policy`
- `assess_counterparty_deep` ($0.02) — same, scans more on-chain history
- `recommend_policy` ($0.002) — decision + wallet-ready spending policy (caps, denylist, approval)
- `report_outcome` (free) — after paying, report delivery to train the reliability flywheel

Tools — vet the **payment itself** (buyer-side):
- `firewall` ($0.002) — should YOUR agent make THIS payment now? Catches fraudulent routing (payTo swapped vs the address you usually pay), drain velocity, overcharge, and injection-sourced instructions. `agent_id` + a wallet-ownership signature are attached automatically from your configured wallet — trusted routing history with no extra steps.
- `firewall_record` (free) — seed your agent's payment history so the firewall has a behavioural baseline.
- `firewall_outcome` (free) — after a verdict, report what actually happened (fraud / legit / …) so the firewall learns which signals are predictive and downweights noisy ones (safety signals stay deterministic).

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

Paid calls cost from **$0.002** (shallow) to **$0.02** (deep), paid automatically
in USDC via x402 (Circle Gateway, gas-free on Base) from the configured wallet.
`report_outcome` is free. (`CLIENT_PRIVATE_KEY` is only needed for the paid tools.)

## Use

The agent calls it before authorizing a payment:

```
assess_counterparty({
  target: { payto_address: "0x..." },
  payment_context: { amount: 10, asset: "USDC" },
  policy: { block_at_score: 70, review_at_score: 40 }
})
→ { decision: "review", risk_score: 52, confidence: 0.41, coverage: {...},
    dimensions: [...], recommendation: "...",
    recommended_policy: { action: "limit", max_payment_usdc: 5, daily_cap_usdc: 15,
                          add_to_denylist: false, require_human_approval: true } }
```

- `block` / `deny` → don't pay
- `review` / `limit` → cap exposure / escrow (use `recommended_policy` for the caps)
- `allow` → proceed

`recommend_policy(...)` returns just the decision + `recommended_policy` — apply
`max_payment_usdc` / `daily_cap_usdc` / `add_to_denylist` directly to your agent
wallet's spending limits. After paying, call `report_outcome({ assessment_id,
outcome })` to improve future scores.

## Disclaimer

Algorithmic risk signal, informational only — **not advice, not an endorsement,
and not an accusation** about any party. Scores are probabilistic estimates from
limited public on-chain data and heuristics, and may misclassify. Do your own due
diligence; don't rely on it as your sole basis to pay or refuse. See
https://402sentinel.com/terms.

MIT.
