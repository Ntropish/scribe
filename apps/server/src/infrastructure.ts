import postgres from "postgres";
import { env } from "./env";

let client: ReturnType<typeof postgres> | null = null;

export function getPostgresClient() {
  if (!client) {
    client = postgres(env.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }
  return client;
}
