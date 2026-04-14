import Constants from "expo-constants";

export function getApiUrl(): string {
  const u = Constants.expoConfig?.extra?.apiUrl;
  if (typeof u === "string" && u.length > 0) return u.replace(/\/$/, "");
  return "https://never-miss-api.onrender.com";
}
