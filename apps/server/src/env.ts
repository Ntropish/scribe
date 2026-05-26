function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  databaseUrl: required("DATABASE_URL"),
  whisperStreamUrl: process.env.WHISPER_STREAM_URL ?? "ws://10.0.0.26:8765",
  whisperStreamHttp: process.env.WHISPER_STREAM_HTTP ?? "http://10.0.0.26:8765",
  oidcIssuer: process.env.OIDC_ISSUER ?? "https://auth.trivorn.org",
  oidcClientId: process.env.OIDC_CLIENT_ID ?? "",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "",
  authDisabled: process.env.AUTH_DISABLED === "true",
};
