import { describe, expect, test } from "bun:test";
import { createSpaceAcl, deriveEffectiveCapability, meetsRole, type AclSql } from "./space-acl";

describe("meetsRole", () => {
  test("null actual never meets any requirement", () => {
    expect(meetsRole(null, "viewer")).toBe(false);
    expect(meetsRole(null, "editor")).toBe(false);
    expect(meetsRole(null, "maintainer")).toBe(false);
  });

  test("viewer meets viewer but not editor or maintainer", () => {
    expect(meetsRole("viewer", "viewer")).toBe(true);
    expect(meetsRole("viewer", "editor")).toBe(false);
    expect(meetsRole("viewer", "maintainer")).toBe(false);
  });

  test("editor meets viewer and editor, not maintainer", () => {
    expect(meetsRole("editor", "viewer")).toBe(true);
    expect(meetsRole("editor", "editor")).toBe(true);
    expect(meetsRole("editor", "maintainer")).toBe(false);
  });

  test("maintainer meets every requirement", () => {
    expect(meetsRole("maintainer", "viewer")).toBe(true);
    expect(meetsRole("maintainer", "editor")).toBe(true);
    expect(meetsRole("maintainer", "maintainer")).toBe(true);
  });
});

describe("deriveEffectiveCapability", () => {
  const space = { createdBySub: "creator-sub" };

  test("admin always becomes maintainer", () => {
    const role = deriveEffectiveCapability(
      space,
      { isAdmin: true, subject: "anyone", managedAgents: [] },
      null,
    );
    expect(role).toBe("maintainer");
  });

  test("the creator gets maintainer regardless of group grant", () => {
    const role = deriveEffectiveCapability(
      space,
      { isAdmin: false, subject: "creator-sub", managedAgents: [] },
      "viewer",
    );
    expect(role).toBe("maintainer");
  });

  test("a managed-agents match gets maintainer", () => {
    const role = deriveEffectiveCapability(
      space,
      { isAdmin: false, subject: "agent-sub", managedAgents: ["creator-sub"] },
      null,
    );
    expect(role).toBe("maintainer");
  });

  test("falls back to the group grant role when no special path applies", () => {
    const role = deriveEffectiveCapability(
      space,
      { isAdmin: false, subject: "stranger", managedAgents: [] },
      "editor",
    );
    expect(role).toBe("editor");
  });

  test("returns null when nothing matches", () => {
    const role = deriveEffectiveCapability(
      space,
      { isAdmin: false, subject: "stranger", managedAgents: [] },
      null,
    );
    expect(role).toBeNull();
  });
});

describe("createSpaceAcl.effectiveCapability (with mocked sql)", () => {
  function makeAcl(grantRole: "maintainer" | "editor" | "viewer" | null) {
    const calls: Array<{ template: TemplateStringsArray; values: unknown[] }> = [];
    const sql = ((template: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ template, values });
      return Promise.resolve(grantRole ? [{ role: grantRole }] : []);
    }) as AclSql;
    return { acl: createSpaceAcl(sql), calls };
  }

  test("skips the DB lookup when admin", async () => {
    const { acl, calls } = makeAcl(null);
    const role = await acl.effectiveCapability(
      { id: "s1", createdBySub: "other" },
      {
        type: "user",
        userId: "u",
        subject: "me",
        username: "me",
        groups: ["admin"],
        managedAgents: [],
      },
    );
    expect(role).toBe("maintainer");
    expect(calls).toHaveLength(0);
  });

  test("returns the grant role when not admin / owner / managed", async () => {
    const { acl, calls } = makeAcl("editor");
    const role = await acl.effectiveCapability(
      { id: "s1", createdBySub: "other" },
      {
        type: "user",
        userId: "u",
        subject: "me",
        username: "me",
        groups: ["team"],
        managedAgents: [],
      },
    );
    expect(role).toBe("editor");
    expect(calls).toHaveLength(1);
  });
});
