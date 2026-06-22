# macOS Release Runbook

This runbook packages the macOS wallet, notarizes it, and uploads the DMG to a
GitHub Release.

## Assumptions

- Repository root: `/Users/v0id/Documents/v0idchain`
- macOS project: `clients/macos/V0idChain.xcodeproj`
- Scheme: `V0idChain`
- Bundle id: `com.v0idchain.macos`
- Version source: `clients/macos/Info.plist` `CFBundleShortVersionString`
- Developer Team ID: `C58WLH687Z`
- Signing identity:
  `Developer ID Application: liuhaoran qin (C58WLH687Z)`
- Notary profile stored in Keychain:
  `v0idchain-notary`
- GitHub repo: `v0id-byte/v0idchain`
- Release tag: `v0.1.0`

Do not use `Apple Development` for public macOS distribution. Gatekeeper accepts
the release only after Developer ID signing plus notarization.

## Preconditions

From the repo root:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool history --keychain-profile v0idchain-notary

gh auth status
```

Expected:

- `Developer ID Application: liuhaoran qin (C58WLH687Z)` is listed.
- `notarytool history` succeeds. It may say `No submission history`.
- `gh auth status` shows a valid GitHub login with repo access.

If the notary profile is missing, the user must create an Apple ID
app-specific password and run:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool store-credentials v0idchain-notary \
  --apple-id "<apple-id-email>" \
  --team-id "C58WLH687Z" \
  --password "<app-specific-password>"
```

Do not ask the user to paste the app-specific password into chat.

## Build The App

```bash
cd /Users/v0id/Documents/v0idchain

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcodebuild \
  -project clients/macos/V0idChain.xcodeproj \
  -scheme V0idChain \
  -configuration Release \
  -derivedDataPath clients/macos/build/DerivedData \
  -destination 'platform=macOS' \
  clean build \
  DEVELOPMENT_TEAM=C58WLH687Z \
  CODE_SIGN_STYLE=Manual \
  "CODE_SIGN_IDENTITY=Developer ID Application: liuhaoran qin (C58WLH687Z)"
```

The signed app should be:

```text
clients/macos/build/DerivedData/Build/Products/Release/V0idChain.app
```

## Re-sign For Notarization

Xcode may sign the app with `--timestamp=none` or add
`com.apple.security.get-task-allow`. Notarization rejects both. Re-sign the app
explicitly without entitlements and with a secure timestamp:

```bash
APP='clients/macos/build/DerivedData/Build/Products/Release/V0idChain.app'

codesign --force \
  --options runtime \
  --timestamp \
  --sign 'Developer ID Application: liuhaoran qin (C58WLH687Z)' \
  "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|Runtime|Timestamp|Identifier'
codesign -d --entitlements :- "$APP" 2>/dev/null || true
```

Expected:

- Authority includes `Developer ID Application: liuhaoran qin (C58WLH687Z)`.
- `TeamIdentifier=C58WLH687Z`.
- A `Timestamp=` line exists.
- Entitlements output is empty, or at least does not contain
  `com.apple.security.get-task-allow`.

## Notarize The App

Notarizing the DMG can hang on this environment. The reliable path is to
notarize a ZIP of the `.app`, staple the app, then build the final DMG from the
stapled app.

```bash
ZIP='clients/macos/build/dist/V0idChain-macOS-0.1.0.zip'
rm -f "$ZIP"
mkdir -p clients/macos/build/dist

ditto -c -k --keepParent "$APP" "$ZIP"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool submit "$ZIP" \
  --keychain-profile v0idchain-notary \
  --wait
```

Expected status:

```text
status: Accepted
```

If status is `Invalid`, fetch the log:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool log <submission-id> --keychain-profile v0idchain-notary
```

## Staple And Verify The App

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun stapler staple "$APP"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun stapler validate "$APP"

spctl --assess --type execute --verbose=4 "$APP"
```

Expected:

```text
accepted
source=Notarized Developer ID
```

## Create The DMG

```bash
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
DIST='clients/macos/build/dist'
STAGE="$DIST/dmg-stage"
DMG="$DIST/V0idChain-macOS-${VERSION}.dmg"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE" "$DIST"

ditto "$APP" "$STAGE/V0idChain.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "V0idChain ${VERSION}" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG"

codesign --force \
  --sign 'Developer ID Application: liuhaoran qin (C58WLH687Z)' \
  --timestamp \
  "$DMG"

codesign --verify --verbose=2 "$DMG"
hdiutil verify "$DMG"
shasum -a 256 "$DMG"
```

## Verify The App Inside The DMG

```bash
MOUNT_OUTPUT=$(hdiutil attach "$DMG" -nobrowse -readonly)
printf '%s\n' "$MOUNT_OUTPUT"

MOUNT_POINT=$(printf '%s\n' "$MOUNT_OUTPUT" | awk '/\/Volumes\// {for (i=3;i<=NF;i++) {printf (i==3?"":" ") $i}; print ""}' | tail -1)
printf 'Mounted at: %s\n' "$MOUNT_POINT"

spctl --assess --type execute --verbose=4 "$MOUNT_POINT/V0idChain.app"

hdiutil detach "$MOUNT_POINT"
```

Expected:

```text
accepted
source=Notarized Developer ID
```

## Upload To GitHub Release

If the release already exists, replace the DMG:

```bash
gh release upload v0.1.0 "$DMG" \
  --repo v0id-byte/v0idchain \
  --clobber
```

If the release does not exist, create it:

```bash
SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')

gh release create v0.1.0 "$DMG" \
  --repo v0id-byte/v0idchain \
  --target main \
  --title 'v0idChain 0.1.0' \
  --notes "macOS wallet DMG.

- Signed with Developer ID Application: liuhaoran qin (Team C58WLH687Z).
- Notarized and stapled.
- Universal macOS app (arm64 + x86_64).
- SHA-256: ${SHA}" \
  --latest
```

Confirm the uploaded asset:

```bash
gh release view v0.1.0 \
  --repo v0id-byte/v0idchain \
  --json tagName,name,url,assets
```

Expected asset:

```text
V0idChain-macOS-0.1.0.dmg
```

The remote asset digest should match the local `shasum -a 256` output.

## Success Criteria

- Release build succeeds.
- App signature verifies with Developer ID identity.
- Notarization status is `Accepted`.
- Stapler validates the app.
- `spctl` accepts the mounted DMG app as `Notarized Developer ID`.
- GitHub Release asset digest matches the local DMG SHA-256.

