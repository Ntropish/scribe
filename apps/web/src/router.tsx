import { createRouter } from "@tanstack/react-router";
import { Route as rootRoute } from "./routes/__root";
import { Route as indexRoute } from "./routes/index";
import { Route as spacesRoute } from "./routes/spaces";
import { Route as spaceDetailRoute } from "./routes/space-detail";
import { Route as grantsRoute } from "./routes/grants";
import { Route as sessionDetailRoute } from "./routes/session-detail";

const routeTree = rootRoute.addChildren([
  indexRoute,
  spacesRoute,
  spaceDetailRoute,
  grantsRoute,
  sessionDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
