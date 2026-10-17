#!/usr/bin/env node
/**
 * 402Sentinel MCP — thin, open-source client.
 *
 * Tools an agent calls around an x402 payment:
 *   - assess_counterparty       ($0.002) — risk score + allow/review/block + a
 *                                          ready-to-apply spending policy
 *   - assess_counterparty_deep  ($0.02)  — same, deeper on-chain history
 *   - recommend_policy          ($0.002) — trimmed view: decision + wallet-ready
 *                                          spending policy (caps, denylist, approval)
 *   - firewall (+record/outcome)($0.002) — buyer-side payment firewall
 *   - compliance_check          ($0.02)  — OFAC + due-diligence tier + structuring
 *   - assess_rwa                ($0.02)  — tokenized-asset (RWA) risk gate
 *   - verify_service            ($0.02)  — opt-in Verified badge (deep audit)
 *   - report_outcome            (FREE)   — after paying, report delivery to train
 *                                          the settlement-reliability flywheel
 *
 * Payments settle via STANDARD x402 (`exact` EIP-3009, USDC on Base, via the
 * Coinbase CDP facilitator — gas-free for the buyer; the facilitator submits the
 * transfer). The scoring model / facilitator logic / flywheel live server-side
 * (closed); this client only forwards + pays, so it's safe to open-source.
 *
 * Config (env):
 *   CLIENT_PRIVATE_KEY  — a Base wallet holding USDC (on-chain). Required for the
 *                         paid tools (not for the free ones). No ETH/gas needed.
 *   SENTINEL_URL        — override base URL (default https://402sentinel.com).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { ownerMessage, payloadLine } from "./owner-proof.js";

const BASE = (process.env.SENTINEL_URL ?? "https://402sentinel.com").replace(/\/$/, "");
const RAW_PK = process.env.CLIENT_PRIVATE_KEY ?? "";
const PK = (!RAW_PK || RAW_PK.startsWith("0xYour"))
  ? null
  : ((RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`) as `0x${string}`);
const account = PK ? privateKeyToAccount(PK) : null;

// Tools whose writes build TRUSTED history → auto-attach a wallet-ownership proof.
// SAFETY: we sign ONLY this exact namespaced template over the request we are about to
// send (never arbitrary or server-supplied content — no blind signing). It's an EIP-191 message signature, NOT a
// transaction: it can't move funds, isn't replayable as a tx, and only proves the
// signer controls its OWN agent_id. Scoped, harmless.
const SIGN_TOOLS = new Set(["firewall", "firewall_record", "firewall_outcome"]);

async function ownerProof(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!account) return {};
  const owner_ts = Math.floor(Date.now() / 1000);
  const owner_sig = await account.signMessage({ message: ownerMessage(action, account.address, owner_ts, payloadLine(action, body)) });
  return { owner_sig, owner_ts };
}

const targetSchema = {
  type: "object",
  required: ["payto_address"],
  properties: {
    payto_address: { type: "string", description: "Chain address that will receive the payment" },
    resource_url: { type: "string", description: "The x402 resource/endpoint URL (optional)" },
    network: { type: "string", description: "CAIP-2 chain id, e.g. eip155:8453 (optional)" },
  },
};
const paymentContextSchema = {
  type: "object",
  properties: {
    amount: { type: "number", description: "Payment amount you're about to make" },
    asset: { type: "string", description: "e.g. USDC" },
  },
};
const assessInput = {
  type: "object",
  required: ["target"],
  properties: {
    target: targetSchema,
    payment_context: paymentContextSchema,
    policy: {
      type: "object",
      properties: {
        block_at_score: { type: "number", description: "risk >= this => block (default 70)" },
        review_at_score: { type: "number", description: "risk >= this => review (default 40)" },
        min_confidence: { type: "number", description: "below this => force review (default 0.5)" },
      },
    },
  },
};
const policyInput = {
  type: "object",
  required: ["target"],
  properties: {
    target: targetSchema,
    payment_context: paymentContextSchema,
    policy: {
      type: "object",
      properties: {
        max_payment_usdc: { type: "number", description: "most you'd expose to ONE counterparty (default 50)" },
        review_ceiling_usdc: { type: "number", description: "hard per-payment cap on the review tier (default 5)" },
        min_confidence: { type: "number", description: "below this => require human approval (default 0.5)" },
      },
    },
  },
};

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  endpoint: string;
  paid: boolean;
  usd?: number; // the tool's advertised price — payFetch refuses challenges above ~2× this
  timeoutMs?: number; // per-call fetch bound (default 30s; verify's deep scan needs ~3min)
};

const TOOLS: Tool[] = [
  {
    name: "assess_counterparty",
    description:
      "Assess the risk of an x402 counterparty (a payTo address) BEFORE paying. Returns a 0-100 risk_score, an allow/review/block decision, honest confidence/coverage, and a ready-to-apply recommended_policy (per-counterparty caps + approval/denylist), scored from on-chain settlement behaviour on Base + a delivery-outcome flywheel. Call before authorizing any x402 payment above your risk threshold. Costs $0.002 (paid automatically in USDC).",
    inputSchema: assessInput,
    endpoint: "/api/assess",
    paid: true,
    usd: 0.002,
  },
  {
    name: "assess_counterparty_deep",
    description:
      "Like assess_counterparty but scans more on-chain settlement history for a higher-confidence read. Use for larger or higher-stakes payments. Costs $0.02 (paid automatically in USDC).",
    inputSchema: assessInput,
    endpoint: "/api/assess/deep",
    paid: true,
    usd: 0.02,
  },
  {
    name: "recommend_policy",
    description:
      "Turn a counterparty's risk into an enforceable spending policy you can apply to your agent wallet. Returns an allow/limit/deny decision plus recommended_policy: max_payment_usdc (per-counterparty cap), daily_cap_usdc, add_to_denylist, require_human_approval. Costs $0.002 (paid automatically in USDC).",
    inputSchema: policyInput,
    endpoint: "/api/policy",
    paid: true,
    usd: 0.002,
  },
  {
    name: "report_outcome",
    description:
      "FREE. After you pay a counterparty, report whether they delivered so 402Sentinel's settlement-reliability flywheel can learn. Pass the assessment_id returned by a prior assessment.",
    inputSchema: {
      type: "object",
      required: ["assessment_id", "outcome"],
      properties: {
        assessment_id: { type: "string", description: "assessment_id from a prior assess/policy call" },
        outcome: { type: "string", enum: ["delivered", "partial", "not_delivered", "overcharged"] },
        tx_hash: { type: "string", description: "settlement tx hash (optional)" },
      },
    },
    endpoint: "/api/report_outcome",
    paid: false,
  },
  {
    name: "firewall",
    description:
      "Buyer-side payment firewall: should YOUR agent make THIS payment now? Where assess_counterparty vets the seller, this vets the payment instruction in the context of your agent's own history + provenance. Returns allow/hold/block + signals: routing_anomaly (payTo swapped vs the address you usually pay = fraudulent routing), velocity_anomaly (drain), amount_anomaly (overcharge), provenance_flag, counterparty_risk, injection_destination (if the payTo appears in the untrusted page/tool-output you're acting on, the destination was injected — pass it as context.untrusted_text), intent_mismatch (pass context.intended={payto,max_amount} so a mid-flight redirect is caught), new_counterparty_burst, recurring_flagged (poisoned-memory loop). STRONGLY recommended: pass untrusted_text + intended to catch prompt-injection payments. agent_id and a wallet-ownership signature are attached AUTOMATICALLY from your configured wallet — you don't pass agent_id, and your routing history is trusted with no extra steps. Costs $0.002. Seed history free with firewall_record.",
    inputSchema: {
      type: "object",
      required: ["payment"],
      properties: {
        agent_id: { type: "string", description: "stable id for your agent — use your payer wallet address" },
        payment: {
          type: "object",
          required: ["payto_address"],
          properties: {
            payto_address: { type: "string", description: "address you're about to pay" },
            amount: { type: "number" },
            asset: { type: "string", description: "e.g. USDC" },
            resource_url: { type: "string", description: "what you're paying for" },
          },
        },
        context: {
          type: "object",
          properties: {
            source: { type: "string", enum: ["tool_output", "web_content", "user", "unknown"], description: "where the payTo/instruction came from" },
            metadata: { type: "object", description: "x402 description/reason strings (scanned for injection)" },
            expected_payto: { type: "string", description: "known-good address for this resource (optional)" },
            untrusted_text: { type: "string", description: "the page/tool-output content you're acting on — if the payTo appears in it, the destination was injected (hard block)" },
            intended: { type: "object", description: "what you meant to do: { payto, max_amount } — any deviation = mid-flight redirect (hard block)", properties: { payto: { type: "string" }, max_amount: { type: "number" } } },
          },
        },
        policy: {
          type: "object",
          properties: {
            max_payment_usdc: { type: "number" },
            velocity_window_min: { type: "number" },
            velocity_cap_usdc: { type: "number" },
            check_counterparty: { type: "boolean" },
            block_on: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    endpoint: "/api/firewall",
    paid: true,
    usd: 0.002,
  },
  {
    name: "compliance_check",
    description:
      "Pre-pay COMPLIANCE screen for regulated-money x402 flows. Returns compliance_decision (pass/flag/block), diligence_tier, obligations, and checks: OFAC sanctions (hit = hard block), counterparty due-diligence tier from the on-chain risk engine, structuring/smurfing detection (many sub-threshold payments to one counterparty aggregating to a reportable sum in 24h — pass target.agent_id, e.g. your wallet, to enable it), and the FATF Travel-Rule threshold reported as informational. Screening support for compliance workflows — not legal advice. Costs $0.02 (paid automatically in USDC).",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "object",
          required: ["payto_address"],
          properties: {
            payto_address: { type: "string", description: "Chain address that will receive the payment" },
            agent_id: { type: "string", description: "The paying agent's id/wallet — enables structuring detection (recommended)" },
          },
        },
        payment_context: paymentContextSchema,
      },
    },
    endpoint: "/api/compliance",
    paid: true,
    usd: 0.02,
  },
  {
    name: "assess_rwa",
    description:
      "RWA risk gate — score a TOKENIZED ASSET (tokenized treasury/stock/credit) BEFORE buying it. Detects PERMISSIONED securities an agent can buy but NOT transfer/redeem (= trapped funds): proxy-aware transfer-restriction scan (resolves the EIP-1967 implementation; ERC-1404/ERC-3643/allowlist/freeze/pause), a behavioral transfer simulation (on-chain revert = the gate is live), live pause state, token identity (symbol/name/supply), and issuer/admin identity + issuer OFAC screening. Returns risk_score 0-100 + allow/review/block + is_permissioned_security + honest not_checked gaps (backing/peg/holder concentration are off-chain). NOT investment advice. Costs $0.02 (paid automatically in USDC).",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "object",
          required: ["payto_address"],
          properties: {
            payto_address: { type: "string", description: "The RWA token CONTRACT address (0x…)" },
            network: { type: "string", enum: ["eip155:8453", "eip155:1"], description: "Chain — Base (default) or Ethereum" },
          },
        },
      },
    },
    endpoint: "/api/assess/rwa",
    paid: true,
    usd: 0.02,
  },
  {
    name: "verify_service",
    description:
      "402Sentinel Verified (opt-in badge): submit YOUR OWN service's payTo for a deep settlement-graph audit (facilitator-aware, multi-hop, exchange-labelled). If it passes (organic, sufficient confidence), a signed time-boxed (30d) credential is issued and your service joins the public allow-list at /api/verified. Positive-only: failing audits are returned privately, never published. SLOW (deep on-chain scan, up to ~3 minutes). Costs $0.02 (paid automatically in USDC).",
    inputSchema: {
      type: "object",
      required: ["payto"],
      properties: {
        payto: { type: "string", description: "Your service's receiving address" },
        resource_url: { type: "string", description: "Your x402 endpoint URL (optional)" },
        claimed_buyers: { type: "number", description: "Buyers you claim to have (optional; checked against the graph)" },
      },
    },
    endpoint: "/api/verify",
    paid: true,
    usd: 0.02,
    timeoutMs: 190000,
  },
  {
    name: "firewall_record",
    description:
      "FREE. Seed your agent's payment history so the firewall has a behavioural baseline (record past/known-good payments). agent_id and the wallet-ownership signature are attached automatically from your configured wallet, so the seeded history is trusted.",
    inputSchema: {
      type: "object",
      required: ["payment"],
      properties: {
        agent_id: { type: "string", description: "use your payer wallet address" },
        payment: {
          type: "object",
          required: ["payto_address"],
          properties: {
            payto_address: { type: "string" },
            amount: { type: "number" },
            asset: { type: "string" },
            resource_url: { type: "string" },
          },
        },
      },
    },
    endpoint: "/api/firewall/record",
    paid: false,
  },
  {
    name: "firewall_outcome",
    description:
      "FREE. After a firewall verdict, report what actually happened so 402Sentinel learns which signals are predictive and downweights noisy ones (hard-block safety signals stay deterministic). Pass the assessment_id (fw_…) from a prior firewall call.",
    inputSchema: {
      type: "object",
      required: ["assessment_id", "outcome"],
      properties: {
        assessment_id: { type: "string", description: "the fw_… id from a prior firewall call" },
        outcome: { type: "string", enum: ["fraud", "confirmed_fraud", "not_delivered", "overcharged", "drained", "scam", "delivered", "legit", "fine"], description: "bad: fraud/confirmed_fraud/not_delivered/overcharged/drained/scam · good: delivered/legit/fine" },
      },
    },
    endpoint: "/api/firewall/outcome",
    paid: false,
  },
];

// Pay a 402-protected endpoint via the STANDARD x402 v2 flow: probe → build the
// EIP-3009 payment locally from the challenge → retry with the payment header.
// (The 402Sentinel server normalises payload shape server-side for CDP compat.)
// SAFETY: the EIP-3009 signature MOVES FUNDS for whatever amount the challenge
// demands — so before signing we assert every offered option is within the tool's
// known price (small buffer). A hostile/compromised server (or a SENTINEL_URL
// pointed elsewhere) can therefore never make this client sign more than ~2× the
// advertised price, instead of "up to the wallet balance".
const PRICE_BUFFER = 2; // tolerate small price bumps without a package update
async function payFetch(url: string, body: Record<string, unknown>, maxUsd: number, timeoutMs: number): Promise<unknown> {
  const client = new x402Client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExactEvmScheme(client, { signer: account as any });
  const http = new x402HTTPClient(client);
  const init = (extra?: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const r1 = await fetch(url, init());
  if (r1.status !== 402) return await r1.json().catch(() => ({}));
  const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n), await r1.json().catch(() => ({})));
  const capAtomic = Math.ceil(maxUsd * PRICE_BUFFER * 1e6); // USDC has 6 decimals
  for (const opt of (pr as { accepts?: Array<{ amount?: string | number; network?: string }> }).accepts ?? []) {
    const amt = Number(opt?.amount ?? 0);
    if (!Number.isFinite(amt) || amt > capAtomic) {
      throw new Error(
        `refusing to pay: the 402 challenge demands ${amt} atomic USDC (> cap ${capAtomic} for this $${maxUsd} tool) — possible hostile/misconfigured server`,
      );
    }
  }
  const payload = await http.createPaymentPayload(pr);
  const headers = http.encodePaymentSignatureHeader(payload);
  const r2 = await fetch(url, init(headers));
  const data = await r2.json().catch(() => ({}));
  if (r2.status === 402) {
    throw new Error("payment was not accepted (still 402) — check the wallet's Base USDC balance");
  }
  return data;
}

async function main() {
  const server = new Server(
    { name: "402sentinel", version: "0.8.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    try {
      // Build the request body; auto-attach the ownership proof + set agent_id = own
      // wallet for the signable tools, so the agent's history is trusted automatically.
      let body: Record<string, unknown> = (args ?? {}) as Record<string, unknown>;
      if (account && SIGN_TOOLS.has(tool.name)) {
        if (tool.name === "firewall" || tool.name === "firewall_record") {
          body = { ...body, agent_id: account.address }; // the wallet IS the agent identity
        }
        body = { ...body, ...(await ownerProof(tool.name, body)) };
      }
      let data: unknown;
      if (tool.paid) {
        if (!account) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "CLIENT_PRIVATE_KEY not set. Provide a Base wallet holding USDC (on-chain; no gas needed) so this tool can pay for the call.",
              }),
            }],
            isError: true,
          };
        }
        data = await payFetch(`${BASE}${tool.endpoint}`, body, tool.usd ?? 0.02, tool.timeoutMs ?? 30000);
      } else {
        // free endpoint — plain POST, no payment
        const res = await fetch(`${BASE}${tool.endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(tool.timeoutMs ?? 30000),
        });
        data = await res.json().catch(() => ({}));
      }
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `${name} failed: ${(e as Error).message}` }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("402sentinel-mcp fatal:", e);
  process.exit(1);
});
