import { ThemeClient } from "@trivorn/theme-client";
import { setDefaultThemeClient } from "@trivorn/theme-client/react";

// Auth Core preferences would be proxied through scribe's own server (TBD).
// Until /api/preferences exists, ThemeClient's apply() will fail silently
// and the app uses default styling.
export const themeClient = new ThemeClient({
  authCoreUrl: typeof window === "undefined" ? "" : window.location.origin,
  getAccessToken: async () => "",
});

setDefaultThemeClient(themeClient);
