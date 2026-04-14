import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** Load `.env` from the monorepo root (or nearest parent directory that has it). */
export function loadEnv(): void {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) {
      // Do not override vars already set (e.g. DATABASE_URL from npm run db:migrate)
      dotenv.config({ path: envPath, override: false });
      // Stale shell exports often keep an old API_PUBLIC_URL (bare IP). Repo .env must win for OAuth.
      const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
      const v = parsed.API_PUBLIC_URL?.trim();
      if (v) process.env.API_PUBLIC_URL = v;
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
