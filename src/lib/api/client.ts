import { hc } from "hono/client";
import type { AppType } from "../../../server";

// Same origin in dev (vite proxies /api → bun server.ts on :8088) and prod
// (bun server.ts serves dist/ + /api on the same port).
export const api = hc<AppType>("/");
