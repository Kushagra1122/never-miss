#!/usr/bin/env node
/**
 * Copies google-services.json into android/app/ so the Google Services Gradle plugin
 * can run and Firebase auto-initializes (fixes "Default FirebaseApp is not initialized").
 *
 * Resolution order:
 * 1. GOOGLE_SERVICES_JSON — EAS File env var (absolute path on the build worker)
 * 2. apps/mobile/google-services.json
 * 3. monorepo root google-services.json
 */
const fs = require("fs");
const path = require("path");

const mobileRoot = path.join(__dirname, "..");
const dest = path.join(mobileRoot, "android", "app", "google-services.json");

const fromEas = process.env.GOOGLE_SERVICES_JSON?.trim();
const candidates = [
  fromEas,
  path.join(mobileRoot, "google-services.json"),
  path.join(mobileRoot, "..", "..", "google-services.json"),
].filter(Boolean);

let src = null;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    src = p;
    break;
  }
}

if (!src) {
  console.warn(
    "[sync-google-services] No google-services.json found. Set EAS secret GOOGLE_SERVICES_JSON (File) or add google-services.json under apps/mobile or repo root. Android push tokens will fail until then.",
  );
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(
  "[sync-google-services] Wrote android/app/google-services.json from",
  src === fromEas ? "GOOGLE_SERVICES_JSON" : path.relative(mobileRoot, src),
);
