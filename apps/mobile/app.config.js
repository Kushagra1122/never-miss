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
  },
  plugins: [
    [
      "expo-notifications",
      {
        icon: "./assets/icon.png",
        color: "#38bdf8",
      },
    ],
  ],
  extra: {
    apiUrl:
      process.env.EXPO_PUBLIC_API_URL ?? "https://never-miss-api.onrender.com",
  },
});
