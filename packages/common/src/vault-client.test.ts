import { describe, it, expect, vi } from "vitest";
import { createVaultClient } from "./vault-client.js";

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
) {
  return vi.fn(async (url, init) => {
    const { status, body } = handler(String(url), init as RequestInit);
    // 204 / 205 / 304 are "no body" statuses — Response constructor rejects a
    // stringified body for these. Pass null to keep the mock valid.
    const noBodyStatus = status === 204 || status === 205 || status === 304;
    return new Response(noBodyStatus ? null : JSON.stringify(body), {
      status,
      headers: noBodyStatus ? {} : { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createVaultClient", () => {
  it("GET returns parsed creds on 200", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: { slack_uid: "U1", provider: "salesforce", creds: { username: "x" } },
    }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "gateway",
      fetchImpl,
    });
    const out = await client.get("U1", "salesforce", "smoke");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.creds).toEqual({ username: "x" });
  });

  it("GET returns not_found on 404", async () => {
    const fetchImpl = mockFetch(() => ({ status: 404, body: { error: "not_found" } }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "gateway",
      fetchImpl,
    });
    const out = await client.get("U1", "salesforce", "smoke");
    expect(out).toEqual({ ok: false, status: 404, error: "not_found" });
  });

  it("GET sets Authorization, x-kally-actor, x-kally-call-purpose", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: { slack_uid: "U1", provider: "salesforce", creds: {} },
    }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "secret-token",
      actor: "proxy",
      fetchImpl,
    });
    await client.get("U1", "salesforce", "sf_fetch_case");
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["x-kally-actor"]).toBe("proxy");
    expect(headers["x-kally-call-purpose"]).toBe("sf_fetch_case");
  });

  it("PUT posts creds with Content-Type JSON and returns ok on 204", async () => {
    const fetchImpl = mockFetch(() => ({ status: 204, body: {} }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "gateway",
      fetchImpl,
    });
    const out = await client.put("U1", "salesforce", { username: "x" });
    expect(out.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ creds: { username: "x" } });
  });

  it("PUT surfaces vault error text on 400", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 400,
      body: { error: "invalid creds: password: String must contain at least 1 character(s)" },
    }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "gateway",
      fetchImpl,
    });
    const out = await client.put("U1", "salesforce", { username: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("invalid creds");
  });

  it("DELETE uses the DELETE verb and returns ok on 204", async () => {
    const fetchImpl = mockFetch(() => ({ status: 204, body: {} }));
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "admin",
      fetchImpl,
    });
    const out = await client.delete("U1", "salesforce");
    expect(out.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(init.method).toBe("DELETE");
  });

  it("returns a fetch error as ok:false/status:0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createVaultClient({
      baseUrl: "http://vault.test",
      token: "t",
      actor: "gateway",
      fetchImpl,
    });
    const out = await client.get("U1", "salesforce", "smoke");
    expect(out).toMatchObject({ ok: false, status: 0 });
  });
});
