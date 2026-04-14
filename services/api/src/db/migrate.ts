import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/loadEnv.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  await pool.end();
  console.log("Migrations complete");
}

main().catch((e: unknown) => {
  console.error(e);
  const code =
    e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  if (code === "28000") {
    console.error(
      "\nHint: Wrong Postgres (often DATABASE_URL still uses :5432). Match docker-compose: port 5433 — see .env.example",
    );
  }
  process.exit(1);
});
