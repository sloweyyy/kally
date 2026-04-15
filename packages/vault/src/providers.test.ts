import { describe, it, expect } from "vitest";
import { isProviderName, validateCred } from "./providers.js";

describe("isProviderName", () => {
  it("accepts known providers", () => {
    expect(isProviderName("salesforce")).toBe(true);
    expect(isProviderName("atlassian")).toBe(true);
  });
  it("rejects unknowns", () => {
    expect(isProviderName("snowflake")).toBe(false);
    expect(isProviderName("")).toBe(false);
  });
});

describe("validateCred — salesforce", () => {
  it("accepts a complete record", () => {
    const out = validateCred("salesforce", {
      client_id: "3MVG9...",
      client_secret: "xxxx",
      username: "alice@example.com",
      password: "pw+token",
      instance_url: "https://katalon-inc.my.salesforce.com",
    });
    expect(out.ok).toBe(true);
  });
  it("rejects missing fields", () => {
    const out = validateCred("salesforce", {
      client_id: "x",
      client_secret: "y",
      username: "a@b.com",
      // password missing
      instance_url: "https://x.my.salesforce.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("password");
  });
  it("rejects non-email username", () => {
    const out = validateCred("salesforce", {
      client_id: "x",
      client_secret: "y",
      username: "not-an-email",
      password: "pw",
      instance_url: "https://x.my.salesforce.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("username");
  });
  it("rejects non-https instance_url", () => {
    const out = validateCred("salesforce", {
      client_id: "x",
      client_secret: "y",
      username: "a@b.com",
      password: "pw",
      instance_url: "http://x.my.salesforce.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("https");
  });
});

describe("validateCred — atlassian", () => {
  it("accepts email + token", () => {
    const out = validateCred("atlassian", {
      email: "alice@example.com",
      api_token: "ATATT3x_...",
    });
    expect(out.ok).toBe(true);
  });
  it("rejects bad email", () => {
    const out = validateCred("atlassian", { email: "nope", api_token: "t" });
    expect(out.ok).toBe(false);
  });
  it("rejects empty token", () => {
    const out = validateCred("atlassian", { email: "a@b.com", api_token: "" });
    expect(out.ok).toBe(false);
  });
});
