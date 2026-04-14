#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d android ]]; then
  echo "Missing android/. Run: npx expo prebuild --platform android"
  exit 1
fi

if [[ -n "${ANDROID_HOME:-}" && ! -d "${ANDROID_HOME}/platforms" ]]; then
  echo ""
  echo "ANDROID_HOME is set to:"
  echo "  $ANDROID_HOME"
  echo "That is not a valid Android SDK: there must be a platforms/ directory inside it."
  echo "Do not point ANDROID_HOME at your app or repo (e.g. never-miss). In Android Studio:"
  echo "  Settings (or Preferences) → Languages & Frameworks → Android SDK"
  echo "  Copy the value shown as \"Android SDK location\" (often ends in .../Android/sdk)."
  echo "Trying other common locations and adb next..."
  echo ""
fi

# Valid SDK root usually has platforms/ (Android Studio can use a non-default path).
resolve_android_sdk() {
  local d adb_path pt sdk
  for d in "${ANDROID_HOME:-}" "$HOME/Library/Android/sdk" "$HOME/android/sdk" "$HOME/Android/Sdk"; do
    if [[ -n "$d" && -d "$d/platforms" ]]; then
      printf '%s' "$d"
      return 0
    fi
  done
  if command -v adb >/dev/null 2>&1; then
    adb_path=$(command -v adb)
    while [[ -L "$adb_path" ]]; do adb_path=$(readlink "$adb_path"); done
    pt=$(dirname "$adb_path")
    if [[ "$(basename "$pt")" == "platform-tools" ]]; then
      sdk=$(cd "$pt/.." && pwd)
      if [[ -d "$sdk/platforms" ]]; then
        printf '%s' "$sdk"
        return 0
      fi
    fi
  fi
  return 1
}

if ! SDK_ROOT="$(resolve_android_sdk)"; then
  echo "Could not find an Android SDK (a directory that contains platforms/)."
  echo ""
  echo "Install Android Studio, then in SDK settings copy the real SDK path, for example:"
  echo "  macOS (default):  $HOME/Library/Android/sdk"
  echo "Then run:"
  echo "  export ANDROID_HOME='<that path>'"
  echo "  npm run android:apk"
  echo ""
  echo "Or use cloud builds (no local SDK):  cd apps/mobile && npx eas-cli@latest build -p android --profile preview"
  exit 1
fi
export ANDROID_HOME="$SDK_ROOT"
echo "Using ANDROID_HOME=$ANDROID_HOME"

if [[ -z "${JAVA_HOME:-}" ]] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "17'; then
  JAVA_17="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  if [[ -z "$JAVA_17" ]]; then
    echo "Set JAVA_HOME to JDK 17, or install Temurin 17 (Gradle fails on Java 25)."
    exit 1
  fi
  export JAVA_HOME="$JAVA_17"
fi

printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties

echo "Building release APK (JAVA_HOME=$JAVA_HOME)..."
(cd android && ./gradlew assembleRelease)

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
if [[ -f "$APK" ]]; then
  echo "APK: $APK"
  ls -la "$APK"
else
  echo "Expected output not found. Check android/app/build/outputs/apk/"
  exit 1
fi
