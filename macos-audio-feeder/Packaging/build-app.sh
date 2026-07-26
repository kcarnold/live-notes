#!/usr/bin/env bash
set -euo pipefail

# Assemble AudioFeederApp into a distributable "Audio Feeder.app" bundle.
#
# A plain `swift build` only produces a bare executable. The menu-bar-only behavior
# (LSUIElement), the microphone permission prompt, and login-item registration
# (SMAppService.mainApp, see AudioFeederApp/LoginItem.swift) all require a real .app bundle
# with an Info.plist — and the LiveKit SDK's WebRTC/UniFFI XCFrameworks are dynamic
# frameworks that SwiftPM links from inside .build/, which breaks the moment the binary is
# moved. This script does what Xcode's "Embed Frameworks" build phase would do by hand:
# build, assemble the bundle, embed those frameworks with a fixed-up @rpath, then sign
# (and optionally notarize).
#
# Usage:
#   Packaging/build-app.sh                     # unsigned/ad-hoc local build, for testing
#   SIGN_IDENTITY="Developer ID Application: You (TEAMID)" Packaging/build-app.sh
#   SIGN_IDENTITY="Developer ID Application: You (TEAMID)" \
#     NOTARIZE_PROFILE=<keychain-profile> Packaging/build-app.sh   # sign + notarize + zip
#
# NOTARIZE_PROFILE refers to credentials stored ahead of time with:
#   xcrun notarytool store-credentials <profile-name> \
#     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#
# Requires macOS + Xcode command line tools (swift, otool, install_name_tool, codesign, and,
# for notarization, ditto / xcrun notarytool / stapler). This script has not been run
# end-to-end on real hardware yet (it was written and reviewed on Linux, where none of those
# tools exist) — treat the framework-embedding step as the part most likely to need a fix,
# the same way AudioFeederSpike's API names were marked as the part to reconcile if the SDK
# changed. Run with `bash -x` if it's not finding a framework it should.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: this builds a macOS .app bundle and must run on macOS." >&2
  exit 1
fi

APP_NAME="Audio Feeder"
APP_DIR=".build/${APP_NAME}.app"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # "-" = ad-hoc signing: local testing only, no stable
                                       # identity across reinstalls (login item / TCC may re-prompt).
NOTARIZE_PROFILE="${NOTARIZE_PROFILE:-}"

echo "==> swift build -c release --product AudioFeederApp"
swift build -c release --product AudioFeederApp
BIN_PATH="$(swift build -c release --product AudioFeederApp --show-bin-path)"

echo "==> Assembling ${APP_DIR}"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$APP_DIR/Contents/Frameworks"
cp "$BIN_PATH/AudioFeederApp" "$APP_DIR/Contents/MacOS/AudioFeederApp"
cp Packaging/Info.plist "$APP_DIR/Contents/Info.plist"
printf 'APPL????' > "$APP_DIR/Contents/PkgInfo"

EXE="$APP_DIR/Contents/MacOS/AudioFeederApp"

echo "==> Embedding dynamic frameworks (LiveKit's WebRTC/UniFFI XCFrameworks)"
otool -L "$EXE" | tail -n +2 | awk '{print $1}' | while read -r dep; do
  case "$dep" in
    /usr/lib/*|/System/*) continue ;;
  esac

  # dep is either an @rpath entry ("@rpath/Name.framework/Name") or an absolute path into
  # .build/artifacts ("/…/Name.framework/Versions/A/Name" or "/…/Name.framework/Name").
  # Either way, pull out "Name.framework/<rest>" so we know the bundle name to locate/embed.
  fw_name_path="$(printf '%s\n' "$dep" | grep -o '[^/]*\.framework/.*' || true)"
  [[ -z "$fw_name_path" ]] && continue
  fw_base="${fw_name_path%%.framework/*}.framework"

  [[ -d "$APP_DIR/Contents/Frameworks/$fw_base" ]] && continue   # already embedded

  found="$(find .build -type d -name "$fw_base" -path '*macos*' 2>/dev/null | head -n1)"
  [[ -z "$found" ]] && found="$(find .build -type d -name "$fw_base" 2>/dev/null | head -n1)"
  if [[ -z "$found" ]]; then
    echo "    warning: could not locate $fw_base under .build/ — app will fail to launch" >&2
    continue
  fi

  echo "    embedding $fw_base (from $found)"
  cp -R "$found" "$APP_DIR/Contents/Frameworks/$fw_base"

  # If the dependency was recorded as an absolute build-tree path, repoint it at @rpath so
  # dyld resolves it via the Frameworks dir instead of the (now-gone) .build/ location.
  case "$dep" in
    @rpath/*) ;;
    *) install_name_tool -change "$dep" "@rpath/$fw_name_path" "$EXE" ;;
  esac
done

if ! otool -l "$EXE" | grep -q '@executable_path/../Frameworks'; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$EXE"
fi

echo "==> Code signing (identity: ${SIGN_IDENTITY})"
for fw in "$APP_DIR"/Contents/Frameworks/*; do
  [[ -e "$fw" ]] || continue
  codesign --force --options runtime --sign "$SIGN_IDENTITY" "$fw"
done
codesign --force --options runtime \
  --entitlements Packaging/AudioFeeder.entitlements \
  --sign "$SIGN_IDENTITY" \
  "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

if [[ -n "$NOTARIZE_PROFILE" ]]; then
  echo "==> Notarizing"
  ZIP_PATH=".build/AudioFeeder.zip"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"
  xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$APP_DIR"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"
  echo "==> Distributable (signed + notarized): $ZIP_PATH"
else
  echo "==> Built: $APP_DIR"
  if [[ "$SIGN_IDENTITY" == "-" ]]; then
    echo "    Ad-hoc signed (local testing only). Set SIGN_IDENTITY to a \"Developer ID"
    echo "    Application: …\" identity, and NOTARIZE_PROFILE, to produce a distributable build."
  fi
fi
