import { describe, expect, test } from "bun:test";
import { createSpaceAcl, deriveEffectiveRole, meetsRole, type AclSql } from "./space-acl";

describe("meetsRole", () => {
  test("null actual never meets any requirement", () => {
    expect(meetsRole(null, "viewer")).toBe(false);
    expect(meetsRole(null, "editor")).toBe(false);
    expect(meetsRole(null, "owner")).toBe(false);
  });

  test("viewer meets viewer but not editor or owner", () => {
    expect(meetsRole("viewer", "viewer")).toBe(true);
    expect(meetsRole("viewer", "editor")).toBe(false);
    expect(meetsRole("viewer", "owner")).toBe(false);
  });

  test("editor meets viewer and editor, not owner", () => {
    expect(meetsRole("editor", "viewer")).toBe(true);
    expect(meetsRole("editor", "editor")).toBe(true);
    expect(meetsRole("editor", "owner")).toBe(false);
  });

  test("owner meets every requirement", () => {
    expect(meetsRole("owner", "viewer")).toBe(true);
    expect(meetsRole("owner", "editor")).toBe(true);
    expect(meetsRole("owner", "owner")).toBe(true);
  });
});

describe("deriveEffectiveRole", () => {
  const space = { createdBySub: "creator-sub" };

  test("admin always becomes owner", () => {
    const role = deriveEffectiveRole(
      space,
      { isAdmin: true, subject: "anyone", managedAgents: [] },
      null,
    );
    expect(role).toBe("owner");
  });

  test("the creator gets owner regardless of group grant", () => {
    const role = deriveEffectiveRole(
      space,
      { isAdmin: false, subject: "creator-sub", managedAgents: [] },
      "viewer",
    );
    expect(role).toBe("owner");
  });

  test("a managed-agents match gets owner", () => {
    const role = deriveEffectiveRole(
      space,
      { isAdmin: false, subject: "agent-sub", managedAgents: ["creator-sub"] },
      null,
    );
    expect(role).toBe("owner");
  });

  test("falls back to the group grant role when no special path applies", () => {
    const role = deriveEffectiveRole(
      space,
      { isAdmin: false, subject: "stranger", managedAgents: [] },
      "editor",
    );
    expect(role).toBe("editor");
  });

  test("returns null when nothing matches", () => {
    const role = deriveEffectiveRole(
      space,
      { isAdmin: false, subject: "stranger", managedAgents: [] },
      null,
    );
    expect(role).toBeNull();
  });
});

describe("createSpaceAcl.effectiveSpaceRole (with mocked sql)", () => {
  function makeAcl(grantRole: "owner" | "editor" | "viewer" | null) {
    const calls: Array<{ template: TemplateStringsArray; values: unknown[] }> = [];
    const sql = ((template: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ template, values });
      return Promise.resolve(grantRole ? [{ role: grantRole }] : []);
    }) as AclSql;
    return { acl: createSpaceAcl(sql), calls };
  }

  test("skips the DB lookup when admin", async () => {
    const { acl, calls } = makeAcl(null);
    const role = await acl.effectiveSpaceRole(
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
    expect(role).toBe("owner");
    expect(calls).toHaveLength(0);
  });

  test("returns the grant role when not admin / owner / managed", async () => {
    const { acl, calls } = makeAcl("editor");
    const role = await acl.effectiveSpaceRole(
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
