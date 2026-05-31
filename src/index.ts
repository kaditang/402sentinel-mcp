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
 *   - report_outcome            (FREE)   — after paying, report delivery to train
 *                                          the settlement-reliability flywheel
 *
 * Payments settle via x402 (Circle Gateway on Base). The scoring model /
 * facilitator logic / flywheel live server-side (closed); this client only
 * forwards + pays, so it's safe to open-source.
 *
 * Config (env):
 *   CLIENT_PRIVATE_KEY  — a Base wallet with USDC in its Circle Gateway balance.
 *                         Required for the paid tools (not for report_outcome).
 *   SENTINEL_URL        — override base URL (default https://402sentinel.com).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const BASE = (process.env.SENTINEL_URL ?? "https://402sentinel.com").replace(/\/$/, "");
const RAW_PK = process.env.CLIENT_PRIVATE_KEY ?? "";

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
};

const TOOLS: Tool[] = [
  {
    name: "assess_counterparty",
    description:
      "Assess the risk of an x402 counterparty (a payTo address) BEFORE paying. Returns a 0-100 risk_score, an allow/review/block decision, honest confidence/coverage, and a ready-to-apply recommended_policy (per-counterparty caps + approval/denylist), scored from on-chain settlement behaviour on Base + a delivery-outcome flywheel. Call before authorizing any x402 payment above your risk threshold. Costs $0.002 (paid automatically in USDC).",
    inputSchema: assessInput,
    endpoint: "/api/assess",
    paid: true,
  },
  {
    name: "assess_counterparty_deep",
    description:
      "Like assess_counterparty but scans more on-chain settlement history for a higher-confidence read. Use for larger or higher-stakes payments. Costs $0.02 (paid automatically in USDC).",
    inputSchema: assessInput,
    endpoint: "/api/assess/deep",
    paid: true,
  },
  {
    name: "recommend_policy",
    description:
      "Turn a counterparty's risk into an enforceable spending policy you can apply to your agent wallet. Returns an allow/limit/deny decision plus recommended_policy: max_payment_usdc (per-counterparty cap), daily_cap_usdc, add_to_denylist, require_human_approval. Costs $0.002 (paid automatically in USDC).",
    inputSchema: policyInput,
    endpoint: "/api/policy",
    paid: true,
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
      "Buyer-side payment firewall: should YOUR agent make THIS payment now? Where assess_counterparty vets the seller, this vets the payment instruction in the context of your agent's own history + provenance. Returns allow/hold/block + signals: routing_anomaly (payTo swapped vs the address you usually pay for this resource = fraudulent routing), velocity_anomaly (drain), amount_anomaly (overcharge), provenance_flag (injection/untrusted source), counterparty_risk. Pass your payer wallet as agent_id. Costs $0.002. Seed history free with firewall_record.",
    inputSchema: {
      type: "object",
      required: ["agent_id", "payment"],
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
  },
  {
    name: "firewall_record",
    description:
      "FREE. Seed your agent's payment history so the firewall has a behavioural baseline (record past/known-good payments). Pass your payer wallet as agent_id.",
    inputSchema: {
      type: "object",
      required: ["agent_id", "payment"],
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
];

function clientOrNull(): GatewayClient | null {
  if (!RAW_PK || RAW_PK.startsWith("0xYour")) return null;
  const pk = (RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`) as `0x${string}`;
  return new GatewayClient({ chain: "base", privateKey: pk });
}

async function main() {
  const server = new Server(
    { name: "402sentinel", version: "0.3.0" },
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
      let data: unknown;
      if (tool.paid) {
        const client = clientOrNull();
        if (!client) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "CLIENT_PRIVATE_KEY not set. Provide a Base wallet (with USDC in its Circle Gateway balance) so this tool can pay for the call.",
              }),
            }],
            isError: true,
          };
        }
        ({ data } = await client.pay(`${BASE}${tool.endpoint}`, { method: "POST", body: args }));
      } else {
        // free endpoint — plain POST, no payment
        const res = await fetch(`${BASE}${tool.endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args ?? {}),
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
