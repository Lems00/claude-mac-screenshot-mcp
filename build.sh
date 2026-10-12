#!/usr/bin/env bash
# Builds the native helpers this MCP server needs:
#   - list_windows        : lists on-screen windows (CGWindowList)
#   - CaptureWindow.app    : captures a specific app's window (ScreenCaptureKit)
#
# Why CaptureWindow is a signed .app bundle and not a plain binary: macOS's
# Screen Recording TCC permission for ScreenCaptureKit is only honored when
# the process is launched through LaunchServices (`open -a`) as a real app
# bundle — a bare Mach-O run directly from a shell gets silently denied even
# after you grant it permission. See README.md "Why this is built this way".
set -euo pipefail
cd "$(dirname "$0")"

echo "Compiling list_windows..."
swiftc list_windows.swift -o list_windows

echo "Compiling capture_window..."
swiftc -target x86_64-apple-macos12.3 capture_window.swift -o capture_window

echo "Packaging CaptureWindow.app..."
rm -rf CaptureWindow.app
mkdir -p CaptureWindow.app/Contents/MacOS
cp capture_window CaptureWindow.app/Contents/MacOS/CaptureWindow
chmod +x CaptureWindow.app/Contents/MacOS/CaptureWindow

cat > CaptureWindow.app/Contents/Info.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>CaptureWindow</string>
	<key>CFBundleIdentifier</key>
	<string>com.claude-mac-screenshot-mcp.capturewindow</string>
	<key>CFBundleName</key>
	<string>CaptureWindow</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.3</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

echo "Ad-hoc signing CaptureWindow.app..."
codesign --force --deep --sign - CaptureWindow.app

echo ""
echo "Build complete."
echo "Next: grant Screen Recording permission to CaptureWindow.app, then register the MCP server — see README.md."
