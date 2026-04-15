import { describe, it, expect } from "vitest";
import { checkUserAccess, type ProxyConfig, type WorkspaceConfig } from "./workspace-config.js";

function mkConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    repos: {},
    support_team_emails: ["phuc.truong@katalon.com", "vi.nguyen@katalon.com"],
    katalon_email_suffixes: ["@katalon.com"],
    ...overrides,
  };
}

function mkProxy(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    upstream: { url: "http://fake" },
    allow: [],
    approve: [],
    ...overrides,
  };
}

describe("checkUserAccess", () => {
  it("public (undefined) policy allows any caller", () => {
    const out = checkUserAccess(mkConfig(), mkProxy(), {});
    expect(out.ok).toBe(true);
  });

  it("public policy allows anonymous caller", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "public" }), {});
    expect(out.ok).toBe(true);
  });

  it("katalon policy allows a @katalon.com email", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "katalon" }), {
      user_id: "U1",
      user_email: "random.dev@katalon.com",
    });
    expect(out.ok).toBe(true);
  });

  it("katalon policy denies an external email", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "katalon" }), {
      user_id: "U2",
      user_email: "someone@gmail.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_katalon");
  });

  it("katalon policy denies when email is missing (scope gap)", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "katalon" }), { user_id: "U3" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unknown_user");
  });

  it("support policy allows members in the list (case-insensitive)", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "support" }), {
      user_id: "U1",
      user_email: "Phuc.Truong@Katalon.COM",
    });
    expect(out.ok).toBe(true);
  });

  it("support policy denies non-members who ARE Katalon", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "support" }), {
      user_id: "U99",
      user_email: "new.engineer@katalon.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_support");
  });

  it("support policy denies external", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "support" }), {
      user_id: "U99",
      user_email: "friend@gmail.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_support");
  });

  it("support policy with empty list denies everyone (fail closed)", () => {
    const out = checkUserAccess(
      mkConfig({ support_team_emails: [] }),
      mkProxy({ access: "support" }),
      { user_id: "U1", user_email: "phuc.truong@katalon.com" },
    );
    expect(out.ok).toBe(false);
  });

  it("message strings are user-friendly and mention the specific email", () => {
    const out = checkUserAccess(mkConfig(), mkProxy({ access: "support" }), {
      user_id: "U99",
      user_email: "outsider@gmail.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("outsider@gmail.com");
      expect(out.message).toContain("Support");
    }
  });
});
