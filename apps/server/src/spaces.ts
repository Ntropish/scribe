import { Hono } from "hono";
import { z } from "zod";
import { getPostgresClient } from "./infrastructure";
import { authMiddleware, getAuth, isAdmin, type AuthContext } from "./middleware";
import {
  effectiveSpaceRole,
  loadSpaceBySlug,
  meetsRole,
  type SpaceRole,
} from "./space-acl";

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase, digits, hyphens");

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

const grantSchema = z.object({
  role: z.enum(["owner", "editor", "viewer"]),
});

const spaces = new Hono<{ Variables: { auth: AuthContext } }>();

spaces.use("*", authMiddleware);

spaces.get("/", async (c) => {
  const auth = getAuth(c);
  const sql = getPostgresClient();

  const rows = await sql<{
    id: string;
    slug: string;
    name: string;
    description: string;
    visibility: "private" | "public";
    created_by_sub: string;
    created_at: string;
    updated_at: string;
    member_role: SpaceRole | null;
  }[]>`
    SELECT
      s.id, s.slug, s.name, s.description, s.visibility,
      s.created_by_sub, s.created_at, s.updated_at,
      CASE
        WHEN ${isAdmin(auth)} THEN 'owner'
        WHEN s.created_by_sub = ${auth.subject} THEN 'owner'
        WHEN s.created_by_sub = ANY(${auth.managedAgents}) THEN 'owner'
        ELSE sg.role
      END AS member_role
    FROM spaces s
    LEFT JOIN LATERAL (
      SELECT role
      FROM space_grants
      WHERE space_id = s.id AND group_name = ANY(${auth.groups})
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
      LIMIT 1
    ) sg ON true
    WHERE s.archived_at IS NULL
      AND (
        ${isAdmin(auth)}
        OR s.visibility = 'public'
        OR s.created_by_sub = ${auth.subject}
        OR s.created_by_sub = ANY(${auth.managedAgents})
        OR sg.role IS NOT NULL
      )
    ORDER BY s.created_at DESC
  `;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      createdBySub: r.created_by_sub,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      memberRole: r.member_role,
    })),
  );
});

spaces.post("/", async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }

  const { slug, name, description = "", visibility = "private" } = parsed.data;
  const sql = getPostgresClient();

  try {
    const rows = await sql<{
      id: string;
      slug: string;
      name: string;
      description: string;
      visibility: "private" | "public";
      created_by_sub: string;
      created_at: string;
      updated_at: string;
    }[]>`
      INSERT INTO spaces (slug, name, description, visibility, created_by_sub, updated_by_sub)
      VALUES (${slug}, ${name}, ${description}, ${visibility}, ${auth.subject}, ${auth.subject})
      RETURNING id, slug, name, description, visibility, created_by_sub, created_at, updated_at
    `;
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return c.json({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      createdBySub: row.created_by_sub,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberRole: "owner" as const,
    }, 201);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      return c.json({ error: "slug already exists" }, 409);
    }
    throw err;
  }
});

spaces.get("/:slug", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "viewer") && space.visibility !== "public") {
    return c.json({ error: "forbidden" }, 403);
  }

  return c.json({
    id: space.id,
    slug: space.slug,
    name: space.name,
    description: space.description,
    visibility: space.visibility,
    createdBySub: space.createdBySub,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    memberRole: role,
  });
});

spaces.patch("/:slug", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const { name, description, visibility } = parsed.data;
  if (name === undefined && description === undefined && visibility === undefined) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const sql = getPostgresClient();
  const rows = await sql<{
    id: string;
    slug: string;
    name: string;
    description: string;
    visibility: "private" | "public";
    created_by_sub: string;
    created_at: string;
    updated_at: string;
  }[]>`
    UPDATE spaces SET
      name = COALESCE(${name ?? null}, name),
      description = COALESCE(${description ?? null}, description),
      visibility = COALESCE(${visibility ?? null}, visibility),
      updated_by_sub = ${auth.subject},
      updated_at = now()
    WHERE id = ${space.id}
    RETURNING id, slug, name, description, visibility,
              created_by_sub, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    createdBySub: row.created_by_sub,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberRole: role,
  });
});

spaces.get("/:slug/grants", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "viewer")) return c.json({ error: "forbidden" }, 403);

  const sql = getPostgresClient();
  const rows = await sql<{
    id: string;
    group_name: string;
    role: SpaceRole;
    created_at: string;
  }[]>`
    SELECT id, group_name, role, created_at
    FROM space_grants
    WHERE space_id = ${space.id}
    ORDER BY group_name ASC
  `;
  return c.json(
    rows.map((r) => ({
      id: r.id,
      groupName: r.group_name,
      role: r.role,
      createdAt: r.created_at,
    })),
  );
});

spaces.put("/:slug/grants/:group", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "owner")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = grantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const groupName = c.req.param("group");
  const sql = getPostgresClient();
  const rows = await sql<{
    id: string;
    group_name: string;
    role: SpaceRole;
    created_at: string;
  }[]>`
    INSERT INTO space_grants (space_id, group_name, role)
    VALUES (${space.id}, ${groupName}, ${parsed.data.role})
    ON CONFLICT (space_id, group_name) DO UPDATE SET role = EXCLUDED.role
    RETURNING id, group_name, role, created_at
  `;
  const row = rows[0];
  if (!row) throw new Error("upsert returned no row");
  return c.json({
    id: row.id,
    groupName: row.group_name,
    role: row.role,
    createdAt: row.created_at,
  });
});

spaces.delete("/:slug/grants/:group", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "owner")) return c.json({ error: "forbidden" }, 403);

  const groupName = c.req.param("group");
  const sql = getPostgresClient();
  await sql`
    DELETE FROM space_grants
    WHERE space_id = ${space.id} AND group_name = ${groupName}
  `;
  return c.body(null, 204);
});

export default spaces;
