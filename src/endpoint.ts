// 402Sentinel was retired on 2026-10-31 and 402sentinel.com is not renewed (it lapses in May 2027), so from
// 0.9.0 there is NO default endpoint, and the retired domain is refused even when configured: after it lapses,
// whoever registers it would receive this client's x402 payments and could return forged verdicts.

export const RETIRED_HOSTS = ["402sentinel.com"];

export type Endpoint = { ok: true; base: string } | { ok: false; reason: string };

export function resolveEndpoint(raw: string | undefined): Endpoint {
  const v = (raw ?? "").trim();
  if (!v) {
    return { ok: false, reason: "402Sentinel was retired on 31 October 2026 and this package has no default endpoint. Set SENTINEL_URL to a server you run and trust, or uninstall the package." };
  }
  let u: URL;
  try { u = new URL(v); } catch { return { ok: false, reason: `SENTINEL_URL is not a valid URL: ${v}` }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (RETIRED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, reason: `${host} is the retired 402Sentinel domain (service ended 31 October 2026; the domain lapses in May 2027 and may then belong to someone else). Refusing to send requests or payments to it.` };
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { ok: false, reason: "SENTINEL_URL must use https (plain http is allowed only for localhost)." };
  }
  return { ok: true, base: v.replace(/\/+$/, "") };
}
