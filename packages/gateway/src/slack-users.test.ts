import { describe, it, expect, vi } from "vitest";
import { createSlackUserResolver, nullSlackUserResolver } from "./slack-users.js";

function mockFetch(response: unknown, status = 200, contentType = "application/json") {
  return vi.fn(async () => {
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
}

describe("createSlackUserResolver", () => {
  it("resolves uid → email on successful users.info response", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      user: {
        id: "U12345",
        name: "phuc",
        real_name: "Phuc Truong",
        profile: { email: "alice@example.com", display_name: "phuc" },
      },
    });
    const resolve = createSlackUserResolver({ token: "xoxb-test", fetchImpl });
    const user = await resolve("U12345");
    expect(user).toEqual({
      id: "U12345",
      email: "alice@example.com",
      display_name: "phuc",
    });
  });

  it("caches repeat lookups for the same uid (only 1 HTTP call)", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      user: {
        id: "U12345",
        profile: { email: "a@b.com", display_name: "A" },
      },
    });
    const resolve = createSlackUserResolver({ token: "xoxb-test", fetchImpl });
    await resolve("U12345");
    await resolve("U12345");
    await resolve("U12345");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("returns undefined and does not cache when Slack returns ok:false", async () => {
    const fetchImpl = mockFetch({ ok: false, error: "user_not_found" });
    const resolve = createSlackUserResolver({ token: "xoxb-test", fetchImpl });
    expect(await resolve("U_BAD")).toBeUndefined();
    // Second call re-fetches because we don't cache negatives.
    await resolve("U_BAD");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("returns undefined on HTTP error status", async () => {
    const fetchImpl = mockFetch({ error: "rate_limited" }, 429);
    const resolve = createSlackUserResolver({ token: "xoxb-test", fetchImpl });
    expect(await resolve("U_RATE")).toBeUndefined();
  });

  it("falls through gracefully when token is missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolve = createSlackUserResolver({ token: "", fetchImpl });
    expect(await resolve("U_ANY")).toBeUndefined();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("returns uid-only when the profile has no email (missing scope)", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      user: {
        id: "U12345",
        name: "vi",
        real_name: "Vi Nguyen",
        profile: { display_name: "vi" },
      },
    });
    const resolve = createSlackUserResolver({ token: "xoxb-test", fetchImpl });
    const user = await resolve("U12345");
    expect(user).toEqual({ id: "U12345", display_name: "vi" });
  });

  it("expires cache entries after ttlMs", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      user: {
        id: "U12345",
        profile: { email: "a@b.com", display_name: "A" },
      },
    });
    const resolve = createSlackUserResolver({
      token: "xoxb-test",
      fetchImpl,
      ttlMs: 10,
    });
    await resolve("U12345");
    await new Promise((r) => setTimeout(r, 20));
    await resolve("U12345");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });
});

describe("nullSlackUserResolver", () => {
  it("always returns undefined — safe default when token is unconfigured", async () => {
    expect(await nullSlackUserResolver("U12345")).toBeUndefined();
    expect(await nullSlackUserResolver("")).toBeUndefined();
  });
});
