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

interface DbSpaceRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  created_by_sub: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface GrantRow {
  role: SpaceRole;
}

// Minimal shape of the postgres-js tagged-template client; tests can pass a
// matching mock without importing the real type.
export interface AclSql {
  <T>(template: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export function meetsRole(actual: SpaceRole | null, required: SpaceRole): boolean {
  if (actual === null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// Pure decision: given the space, the caller, and the role we found in a
// group_grants lookup (if any), what's the caller's effective role on the space?
// Extracted so it can be unit tested without a DB.
export function deriveEffectiveRole(
  space: { createdBySub: string },
  caller: { isAdmin: boolean; subject: string; managedAgents: string[] },
  groupGrantRole: SpaceRole | null,
): SpaceRole | null {
  if (caller.isAdmin) return "owner";
  if (space.createdBySub === caller.subject) return "owner";
  if (caller.managedAgents.includes(space.createdBySub)) return "owner";
  return groupGrantRole;
}

function toSpaceCore(row: DbSpaceRow): SpaceCore {
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

export function createSpaceAcl(sql: AclSql) {
  async function loadSpaceBySlug(slug: string): Promise<SpaceCore | null> {
    const rows = await sql<DbSpaceRow[]>`
      SELECT id, slug, name, description, visibility,
             created_by_sub, created_at, updated_at, archived_at
      FROM spaces WHERE slug = ${slug}
    `;
    return rows[0] ? toSpaceCore(rows[0]) : null;
  }

  async function loadSpaceById(id: string): Promise<SpaceCore | null> {
    const rows = await sql<DbSpaceRow[]>`
      SELECT id, slug, name, description, visibility,
             created_by_sub, created_at, updated_at, archived_at
      FROM spaces WHERE id = ${id}
    `;
    return rows[0] ? toSpaceCore(rows[0]) : null;
  }

  async function lookupGroupGrantRole(spaceId: string, groups: string[]): Promise<SpaceRole | null> {
    if (groups.length === 0) return null;
    const rows = await sql<GrantRow[]>`
      SELECT role
      FROM space_grants
      WHERE space_id = ${spaceId}
        AND group_name = ANY(${groups})
      ORDER BY
        CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
      LIMIT 1
    `;
    return rows[0]?.role ?? null;
  }

  async function effectiveSpaceRole(
    space: { id: string; createdBySub: string },
    auth: AuthContext,
  ): Promise<SpaceRole | null> {
    const callerIsAdmin = isAdmin(auth);
    if (callerIsAdmin) return "owner";
    if (space.createdBySub === auth.subject) return "owner";
    if (auth.managedAgents.includes(space.createdBySub)) return "owner";
    return lookupGroupGrantRole(space.id, auth.groups);
  }

  return { loadSpaceBySlug, loadSpaceById, lookupGroupGrantRole, effectiveSpaceRole };
}

let defaultAcl: ReturnType<typeof createSpaceAcl> | null = null;
function getDefaultAcl(): ReturnType<typeof createSpaceAcl> {
  if (!defaultAcl) defaultAcl = createSpaceAcl(getPostgresClient() as unknown as AclSql);
  return defaultAcl;
}

export const loadSpaceBySlug = (slug: string) => getDefaultAcl().loadSpaceBySlug(slug);
export const loadSpaceById = (id: string) => getDefaultAcl().loadSpaceById(id);
export const effectiveSpaceRole = (
  space: { id: string; createdBySub: string },
  auth: AuthContext,
) => getDefaultAcl().effectiveSpaceRole(space, auth);
