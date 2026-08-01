#!/usr/bin/env bash
set -euo pipefail

# Build "Audio Feeder.app" via the Xcode project generated from project.yml.
#
# Xcode's app target handles what a plain SwiftPM build can't: embedding and re-signing the
# LiveKit SDK's binary XCFrameworks (WebRTC/UniFFI) so they resolve at runtime, Info.plist
# processing, entitlements, and the hardened runtime needed for notarization.
#
# Usage:
#   Packaging/build-app.sh                       # local unsigned build, for testing
#   TEAM_ID=ABCDE12345 Packaging/build-app.sh    # archive + export a Developer ID build
#   TEAM_ID=ABCDE12345 NOTARIZE_PROFILE=<profile> Packaging/build-app.sh   # + notarize/staple
#
# NOTARIZE_PROFILE refers to credentials stored ahead of time with:
#   xcrun notarytool store-credentials <profile-name> \
#     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: building a macOS .app requires macOS + Xcode." >&2
  exit 1
fi

TEAM_ID="${TEAM_ID:-}"
NOTARIZE_PROFILE="${NOTARIZE_PROFILE:-}"
BUILD_DIR="$ROOT_DIR/.build/xcode"
SCHEME="AudioFeederApp"
APP_NAME="Audio Feeder"

# The .xcodeproj is generated, not checked in — regenerate so it always matches project.yml.
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: xcodegen not found. Install it with: brew install xcodegen" >&2
  exit 1
fi
echo "==> xcodegen generate"
xcodegen generate

if [[ -z "$TEAM_ID" ]]; then
  # ENABLE_HARDENED_RUNTIME=NO is required here, not a shortcut: the hardened runtime turns on
  # library validation, which demands that LiveKit's embedded WebRTC/UniFFI frameworks carry
  # the same Team ID as the app. They only get ours when a real Developer ID re-signs them
  # during archive/export, so an ad-hoc-signed hardened build dies at launch with
  # "different Team IDs". The archive path below leaves the hardened runtime on, as
  # notarization requires.
  echo "==> Building (unsigned, local testing only)"
  xcodebuild -project AudioFeeder.xcodeproj -scheme "$SCHEME" -configuration Release \
    -derivedDataPath "$BUILD_DIR" \
    ENABLE_HARDENED_RUNTIME=NO \
    build
  echo "==> Built: \"$BUILD_DIR/Build/Products/Release/$APP_NAME.app\""
  echo "    Unsigned. Set TEAM_ID (and NOTARIZE_PROFILE) for a distributable build."
  exit 0
fi

ARCHIVE_PATH="$BUILD_DIR/$APP_NAME.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
EXPORT_PLIST="$BUILD_DIR/ExportOptions.plist"

echo "==> Archiving"
rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR"
xcodebuild -project AudioFeeder.xcodeproj -scheme "$SCHEME" -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  archive

mkdir -p "$BUILD_DIR"
cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>developer-id</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
PLIST

echo "==> Exporting Developer ID build"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "$EXPORT_DIR"

APP_PATH="$EXPORT_DIR/$APP_NAME.app"
ZIP_PATH="$BUILD_DIR/AudioFeeder.zip"

if [[ -n "$NOTARIZE_PROFILE" ]]; then
  echo "==> Notarizing"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"
  xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$APP_PATH"
  # Re-zip so the distributed archive contains the stapled ticket.
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"
  echo "==> Distributable (signed + notarized): $ZIP_PATH"
else
  echo "==> Signed (not notarized): $APP_PATH"
  echo "    Set NOTARIZE_PROFILE to notarize and staple."
fi
