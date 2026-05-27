import { getPostgresClient } from "./infrastructure";
import { isAdmin, type AuthContext } from "./middleware";

// Roles that can be granted to a group via space_grants. 'owner' is no longer
// a grantable role: ownership is recorded on spaces.created_by_sub and is not
// transferable yet.
export type SpaceRole = "maintainer" | "editor" | "viewer";

const ROLE_RANK: Record<SpaceRole, number> = { maintainer: 3, editor: 2, viewer: 1 };

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

export interface AclSql {
  <T>(template: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export function meetsRole(actual: SpaceRole | null, required: SpaceRole): boolean {
  if (actual === null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// Pure decision: given the space, the caller, and the role we found in a
// group_grants lookup (if any), what's the caller's effective capability on
// the space? Admin, the actual creator, and a managed-agent acting for the
// creator all get the top grantable capability (maintainer); everyone else
// gets whatever the group grant gave them, or null.
export function deriveEffectiveCapability(
  space: { createdBySub: string },
  caller: { isAdmin: boolean; subject: string; managedAgents: string[] },
  groupGrantRole: SpaceRole | null,
): SpaceRole | null {
  if (caller.isAdmin) return "maintainer";
  if (space.createdBySub === caller.subject) return "maintainer";
  if (caller.managedAgents.includes(space.createdBySub)) return "maintainer";
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
        CASE role WHEN 'maintainer' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
      LIMIT 1
    `;
    return rows[0]?.role ?? null;
  }

  async function effectiveCapability(
    space: { id: string; createdBySub: string },
    auth: AuthContext,
  ): Promise<SpaceRole | null> {
    if (isAdmin(auth)) return "maintainer";
    if (space.createdBySub === auth.subject) return "maintainer";
    if (auth.managedAgents.includes(space.createdBySub)) return "maintainer";
    return lookupGroupGrantRole(space.id, auth.groups);
  }

  return { loadSpaceBySlug, loadSpaceById, lookupGroupGrantRole, effectiveCapability };
}

let defaultAcl: ReturnType<typeof createSpaceAcl> | null = null;
function getDefaultAcl(): ReturnType<typeof createSpaceAcl> {
  if (!defaultAcl) defaultAcl = createSpaceAcl(getPostgresClient() as unknown as AclSql);
  return defaultAcl;
}

export const loadSpaceBySlug = (slug: string) => getDefaultAcl().loadSpaceBySlug(slug);
export const loadSpaceById = (id: string) => getDefaultAcl().loadSpaceById(id);
export const effectiveCapability = (
  space: { id: string; createdBySub: string },
  auth: AuthContext,
) => getDefaultAcl().effectiveCapability(space, auth);
