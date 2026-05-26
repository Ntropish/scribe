import { getPostgresClient } from "./infrastructure";
import { isAdmin, type AuthContext } from "./middleware";

export type SpaceRole = "owner" | "editor" | "viewer";

const ROLE_RANK: Record<SpaceRole, number> = { owner: 3, editor: 2, viewer: 1 };

export interface SpaceCore {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function meetsRole(actual: SpaceRole | null, required: SpaceRole): boolean {
  if (actual === null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

function toSpaceCore(row: {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  created_by_sub: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}): SpaceCore {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    createdBySub: row.created_by_sub,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function loadSpaceBySlug(slug: string): Promise<SpaceCore | null> {
  const sql = getPostgresClient();
  const rows = await sql<Parameters<typeof toSpaceCore>[0][]>`
    SELECT id, slug, name, description, visibility,
           created_by_sub, created_at, updated_at, archived_at
    FROM spaces WHERE slug = ${slug}
  `;
  return rows[0] ? toSpaceCore(rows[0]) : null;
}

export async function loadSpaceById(id: string): Promise<SpaceCore | null> {
  const sql = getPostgresClient();
  const rows = await sql<Parameters<typeof toSpaceCore>[0][]>`
    SELECT id, slug, name, description, visibility,
           created_by_sub, created_at, updated_at, archived_at
    FROM spaces WHERE id = ${id}
  `;
  return rows[0] ? toSpaceCore(rows[0]) : null;
}

export async function effectiveSpaceRole(
  space: { id: string; createdBySub: string },
  auth: AuthContext,
): Promise<SpaceRole | null> {
  if (isAdmin(auth)) return "owner";
  if (space.createdBySub === auth.subject) return "owner";
  if (auth.managedAgents.includes(space.createdBySub)) return "owner";

  if (auth.groups.length === 0) return null;
  const sql = getPostgresClient();
  const rows = await sql<{ role: SpaceRole }[]>`
    SELECT role
    FROM space_grants
    WHERE space_id = ${space.id}
      AND group_name = ANY(${auth.groups})
    ORDER BY
      CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
    LIMIT 1
  `;
  return rows[0]?.role ?? null;
}
