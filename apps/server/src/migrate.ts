import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPostgresClient } from "./infrastructure";

interface AppliedRow {
  filename: string;
}

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

async function ensureTable() {
  const sql = getPostgresClient();
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function listFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

async function applied(): Promise<Set<string>> {
  const sql = getPostgresClient();
  const rows = await sql<AppliedRow[]>`SELECT filename FROM schema_migrations`;
  return new Set(rows.map((r) => r.filename));
}

export async function runMigrations() {
  await ensureTable();
  const files = await listFiles();
  const done = await applied();

  for (const filename of files) {
    if (done.has(filename)) continue;
    const sqlText = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    const sql = getPostgresClient();
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx.unsafe("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    });
    console.log(`Applied ${filename}`);
  }
}

if (import.meta.main) {
  const sql = getPostgresClient();
  try {
    await runMigrations();
  } finally {
    await sql.end({ timeout: 5 });
  }
}
