#!/usr/bin/env node
/**
 * Copies google-services.json into android/app/ so the Google Services Gradle plugin
 * can run and Firebase auto-initializes (fixes "Default FirebaseApp is not initialized").
 *
 * Run from `eas-build-post-install` (after `expo prebuild` on EAS) so the file is not
 * wiped by prebuild. See: https://docs.expo.dev/build-reference/npm-hooks/
 *
 * Sources, in order:
 * 1. GOOGLE_SERVICES_JSON — EAS File env var (absolute path on the build worker)
 * 2. apps/mobile/google-services.json
 * 3. monorepo root google-services.json
 */
const fs = require("fs");
const path = require("path");

const mobileRoot = path.join(__dirname, "..");
const dest = path.join(mobileRoot, "android", "app", "google-services.json");

const easBuild =
  process.env.EAS_BUILD === "true" || process.env.EAS_BUILD === "1";
const platform = process.env.EAS_BUILD_PLATFORM || "(unset)";
const fromEas = process.env.GOOGLE_SERVICES_JSON?.trim();
const easPathExists = Boolean(fromEas && fs.existsSync(fromEas));

const candidates = [
  fromEas,
  path.join(mobileRoot, "google-services.json"),
  path.join(mobileRoot, "..", "..", "google-services.json"),
].filter(Boolean);

console.log(
  "[sync-google-services] cwd=%s EAS_BUILD=%s EAS_BUILD_PLATFORM=%s GOOGLE_SERVICES_JSON set=%s pathExists=%s",
  process.cwd(),
  easBuild ? process.env.EAS_BUILD : "(not eas)",
  platform,
  Boolean(fromEas),
  easPathExists,
);

let src = null;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    src = p;
    break;
  }
}

const isEasAndroid = easBuild && platform === "android";

if (!src) {
  console.warn(
    "[sync-google-services] No google-services.json found from EAS env, apps/mobile, or repo root.",
  );
  if (isEasAndroid) {
    console.error(
      "[sync-google-services] FATAL: EAS Android build requires the File env var GOOGLE_SERVICES_JSON on the preview (or production) profile you use. Expo → Environment variables → attach the same file to preview → rebuild.",
    );
    process.exit(1);
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(
  "[sync-google-services] OK → android/app/google-services.json from",
  src === fromEas ? "GOOGLE_SERVICES_JSON" : path.relative(mobileRoot, src),
);
