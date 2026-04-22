const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath, override) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!key) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile(path.join(__dirname, "../../.env"), false);
loadEnvFile(path.join(__dirname, ".env"), true);

/**
 * Firebase client config for Android FCM (Expo push). Sources, in order:
 * 1. EAS "File" env var `GOOGLE_SERVICES_JSON` → absolute path to the JSON on the builder
 * 2. apps/mobile/google-services.json
 * 3. repo root google-services.json
 *
 * If the file is gitignored, add an EAS secret (File) named GOOGLE_SERVICES_JSON for your
 * build profile so cloud builds receive it.
 */
function resolveGoogleServicesFileForExpo() {
  const fromEas = process.env.GOOGLE_SERVICES_JSON?.trim();
  if (fromEas && fs.existsSync(fromEas)) {
    return fromEas;
  }
  const candidates = [
    path.join(__dirname, "google-services.json"),
    path.join(__dirname, "..", "..", "google-services.json"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;
  return path.relative(__dirname, found).split(path.sep).join("/");
}

const googleServicesFile = resolveGoogleServicesFileForExpo();

module.exports = ({ config }) => ({
  ...config,
  name: "Never Miss",
  slug: "never-miss",
  scheme: "nevermiss",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#0f172a",
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: "com.nevermiss.app",
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0f172a",
    },
    package: "com.nevermiss.app",
    ...(googleServicesFile ? { googleServicesFile: googleServicesFile } : {}),
  },
  plugins: [
    [
      "expo-notifications",
      {
        icon: "./assets/icon.png",
        color: "#38bdf8",
      },
    ],
    "expo-background-task",
  ],
  extra: {
    apiUrl:
      process.env.EXPO_PUBLIC_API_URL ?? "https://never-miss-api.onrender.com",
    eas: {
      projectId: "b4cfd82d-4a35-475e-98fc-ae90b408108e",
    },
  },
});
