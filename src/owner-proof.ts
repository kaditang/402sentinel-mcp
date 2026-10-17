// Wallet-ownership proof for 402Sentinel's firewall writes (v2, 2026-10-17).
//
// The signed message carries a hash of WHAT is being written, and the server accepts each
// signed message once, so a seen signature can't be replayed with a different payTo.
// Must match auth.py in the core byte for byte:
//   402sentinel:v2:<action>:<agent lowercased>:<unix ts>:<sha256 hex of payload line>
//   payload line: "<payto lowercased>|<resource_url>|<Math.round(amount*1e6)>" (firewall, firewall_record)
//                 "<assessment_id>|<outcome>"                                    (firewall_outcome)
import { createHash } from "node:crypto";

// The payload line is built from the request body that is about to be sent.
export function payloadLine(action: string, body: Record<string, unknown>): string {
  if (action === "firewall_outcome") return `${body.assessment_id ?? ""}|${body.outcome ?? ""}`;
  const p = (body.payment ?? {}) as Record<string, unknown>;
  const micro = Math.round(Number(p.amount ?? 0) * 1e6);
  return `${String(p.payto_address ?? "").toLowerCase()}|${p.resource_url ?? ""}|${micro}`;
}

export function ownerMessage(action: string, agent: string, ts: number, line: string): string {
  const digest = createHash("sha256").update(line).digest("hex");
  return `402sentinel:v2:${action}:${agent.toLowerCase()}:${ts}:${digest}`;
}

