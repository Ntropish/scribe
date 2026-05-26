// Lazy-validated environment. Reading from `env` is safe at module load time
// even in tests; values are validated by `validateEnv()` from the entry point.

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  databaseUrl: process.env.DATABASE_URL ?? "",
  whisperStreamUrl: process.env.WHISPER_STREAM_URL ?? "ws://10.0.0.26:8765",
  whisperStreamHttp: process.env.WHISPER_STREAM_HTTP ?? "http://10.0.0.26:8765",
  oidcIssuer: process.env.OIDC_ISSUER ?? "https://auth.trivorn.org",
  oidcClientId: process.env.OIDC_CLIENT_ID ?? "",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "",
  authDisabled: process.env.AUTH_DISABLED === "true",
};

const REQUIRED_AT_STARTUP = ["DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const;

export function validateEnv(): void {
  const missing = REQUIRED_AT_STARTUP.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
