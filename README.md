# 402sentinel-mcp

> [!WARNING]
> **Retirement notice.** The 402Sentinel service this package talks to (402sentinel.com) will be retired on **31 October 2026**, and the domain will not be renewed (it lapses in May 2027). After 31 October the default endpoint stops answering; after May 2027 the domain may be controlled by someone else. **This package can make x402 payments, so do not keep a version that defaults to 402sentinel.com** — uninstall it, or point it only at an endpoint you trust. The package is deprecated; the code stays here under its licence.

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

Tools — vet the **asset** and the **flow**:
- `assess_rwa` ($0.02) — RWA risk gate: score a **tokenized asset** (treasury/stock/credit) before buying it. Proxy-aware transfer-restriction scan + behavioral transfer simulation — catches permissioned securities an agent can buy but **not transfer or redeem** (trapped funds), live pause state, issuer identity + issuer sanctions.
- `compliance_check` ($0.02) — pre-pay compliance screen: OFAC sanctions (hard block), counterparty due-diligence tier, structuring/smurfing detection, FATF Travel-Rule threshold (informational). Not legal advice.
- `verify_service` ($0.02) — opt-in **402Sentinel Verified** badge: submit your own payTo for a deep settlement-graph audit; pass → signed time-boxed credential + public allow-list. Failures stay private.

It's a thin client for the hosted service at **https://402sentinel.com** — the
scoring model and facilitator-identification logic live server-side (closed); this
package only forwards the request and pays for it, so it's open source.

## Quickstart — gate a payment in 5 lines

Before your agent pays **any** x402 counterparty, ask the firewall; if it doesn't say
`allow`, don't pay. No MCP needed — any standard x402 v2 client works:

```ts
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const http = new x402HTTPClient(client);

const body = JSON.stringify({
  payment: { payto_address: target, amount, resource_url },
  context: { source: "web_content", untrusted_text: pageYouActedOn },   // pass what you scraped
});
const url = "https://402sentinel.com/api/firewall";
const init = (h = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...h }, body });
const r1 = await fetch(url, init());
const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n), await r1.json());
const payment = http.encodePaymentSignatureHeader(await http.createPaymentPayload(pr));
const data = await (await fetch(url, init(payment))).json();

if (data.decision !== "allow") throw new Error(`402Sentinel ${data.decision}: ${data.recommended_action}`);
// …safe to pay `target`.
```

That one $0.002 call catches **fraudulent routing** (payTo swapped vs the address you
usually pay), **prompt-injection payments** (a payTo that appeared in `untrusted_text`),
**drains**, **overcharges**, and **sanctioned/illicit** counterparties.

**In an MCP framework** (Claude, Cursor, …) instead, just add the server — your agent gets
all 10 tools by name (see Configure below):

```jsonc
{ "mcpServers": { "402sentinel": { "command": "402sentinel-mcp", "env": { "CLIENT_PRIVATE_KEY": "0x…" } } } }
```

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
        "CLIENT_PRIVATE_KEY": "0x...  // a Base wallet holding USDC on-chain (no ETH/gas needed)"
      }
    }
  }
}
```

Paid calls cost from **$0.002** (shallow) to **$0.02** (deep), paid automatically
in USDC via standard x402 (`exact` EIP-3009 on Base — the facilitator submits the
transfer, so the buyer needs no gas) from the configured wallet. The free tools
need no key.

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
