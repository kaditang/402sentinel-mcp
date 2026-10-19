import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEndpoint } from "./endpoint.ts";

test("no default endpoint", () => {
  assert.equal(resolveEndpoint(undefined).ok, false);
  assert.equal(resolveEndpoint("  ").ok, false);
});
test("the retired domain is refused even when configured", () => {
  for (const u of ["https://402sentinel.com", "https://402SENTINEL.com/", "https://www.402sentinel.com", "https://402sentinel.com.", "http://api.402sentinel.com"]) {
    const r = resolveEndpoint(u);
    assert.equal(r.ok, false, u);
  }
});
test("lookalikes are not caught by suffix matching on the wrong boundary", () => {
  const r = resolveEndpoint("https://not402sentinel.com");
  assert.equal(r.ok, true);
});
test("https required except localhost", () => {
  assert.equal(resolveEndpoint("http://example.com").ok, false);
  assert.deepEqual(resolveEndpoint("http://127.0.0.1:8402/"), { ok: true, base: "http://127.0.0.1:8402" });
  assert.deepEqual(resolveEndpoint("https://sentinel.example.com/"), { ok: true, base: "https://sentinel.example.com" });
  assert.equal(resolveEndpoint("not a url").ok, false);
});
