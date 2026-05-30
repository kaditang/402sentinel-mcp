#!/usr/bin/env node
/**
 * 402Sentinel MCP — thin, open-source client.
 *
 * Exposes one tool, `assess_counterparty`, that an agent calls BEFORE paying an
 * x402 counterparty. It pays $0.01 (x402, Circle Gateway on Base) to the hosted
 * 402sentinel.com scoring service and returns a 0-100 risk score + allow/review/
 * block decision. The scoring model / facilitator logic live server-side
 * (closed); this client only forwards + pays, so it's safe to open-source.
 *
 * Config (env):
 *   CLIENT_PRIVATE_KEY  — a Base wallet with USDC in its Circle Gateway balance
 *                         (it pays $0.01 per assessment). Required.
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

const TOOLS = [
  {
    name: "assess_counterparty",
    description:
      "Assess the risk of an x402 counterparty (a payTo address) BEFORE paying. Returns a 0-100 risk_score and an allow/review/block decision relative to your policy, scored from on-chain settlement behaviour on Base (address age, facilitator-aware payer diversity, settlement maturity) with honest confidence/coverage. Call this before authorizing any x402 payment above your risk threshold. Costs $0.01 (paid automatically in USDC).",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "object",
          required: ["payto_address"],
          properties: {
            payto_address: { type: "string", description: "Chain address that will receive the payment" },
            resource_url: { type: "string", description: "The x402 resource/endpoint URL (optional)" },
            network: { type: "string", description: "CAIP-2 chain id, e.g. eip155:8453 (optional)" },
          },
        },
        payment_context: {
          type: "object",
          properties: {
            amount: { type: "number", description: "Payment amount you're about to make" },
            asset: { type: "string", description: "e.g. USDC" },
          },
        },
        policy: {
          type: "object",
          properties: {
            block_at_score: { type: "number", description: "risk >= this => block (default 70)" },
            review_at_score: { type: "number", description: "risk >= this => review (default 40)" },
            min_confidence: { type: "number", description: "below this => force review (default 0.5)" },
          },
        },
        depth: { type: "string", enum: ["shallow", "deep"], description: "shallow=cheap/cached, deep=fresh (default shallow)" },
      },
    },
  },
];

function clientOrNull(): GatewayClient | null {
  if (!RAW_PK || RAW_PK.startsWith("0xYour")) return null;
  const pk = (RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`) as `0x${string}`;
  return new GatewayClient({ chain: "base", privateKey: pk });
}

async function main() {
  const server = new Server(
    { name: "402sentinel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name !== "assess_counterparty") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const client = clientOrNull();
    if (!client) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "CLIENT_PRIVATE_KEY not set. Provide a Base wallet (with USDC in its Circle Gateway balance) so this tool can pay $0.01 per assessment.",
          }),
        }],
        isError: true,
      };
    }
    try {
      const { data } = await client.pay(`${BASE}/api/assess`, {
        method: "POST",
        body: args,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `assessment failed: ${(e as Error).message}` }) }],
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
