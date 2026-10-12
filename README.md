# claude-mac-screenshot-mcp

Give [Claude Code](https://claude.com/claude-code) real eyes on your Mac: a small MCP server that lets Claude take screenshots, capture a specific app's window by name, and query your real macOS/hardware info — directly, as native tool calls, no copy-pasting screenshots back and forth.

Built the hard way, through a very long trial-and-error session on a real machine (an old-ish MacBook Pro on Monterey). This README documents every dead end so you don't have to hit them again — especially if you're a "VibeCoder" running Claude Code on an older Mac, where these permission quirks are extremely common.

## What you get

Four tools, available to Claude as `mcp__screenshot__*`:

- **`capture_screenshot`** — full screen, interactive window click, or interactive region selection.
- **`capture_app_window`** — capture a specific app's window **by name**, with no click and no Accessibility permission. Works even if the app is full-screen on a different Space than the one currently active (the thing that makes this repo exist — see below).
- **`list_windows`** — list all on-screen windows (owner, title, id, bounds).
- **`system_info`** — real `sw_vers` + hardware model, so Claude stops guessing what Mac/OS you're on.

## Install

Requires: macOS 12.3+ (ScreenCaptureKit), Xcode Command Line Tools (`xcode-select --install`), Node 18+, and the `claude` CLI.

```bash
git clone https://github.com/Lems00/claude-mac-screenshot-mcp.git
cd claude-mac-screenshot-mcp
npm install
npm run build
```

`npm run build` compiles two native Swift helpers and packages one of them into a signed `.app` bundle — read [Why this is built this way](#why-this-is-built-this-way) to understand why that's necessary.

### Grant permissions (one-time, manual — can't be scripted)

1. **Screen Recording** for `CaptureWindow.app`:
   System Settings → Privacy & Security → Screen Recording → **+** → navigate to this repo's `CaptureWindow.app` → enable it.
   (Tip: `open -R CaptureWindow.app` reveals it in Finder, ready to drag into the list.)
2. That's it. You do **not** need to grant Accessibility to anything — see below for why we deliberately avoided that path.

### Register the MCP server with Claude Code

```bash
claude mcp add --scope user screenshot -- node "$(pwd)/index.js"
```

`--scope user` makes it available in every project, not just this one. Restart your current Claude Code session (or start a new one) for the tools to appear — a server registered mid-session isn't picked up by that session's already-loaded tool list.

Verify:
```bash
claude mcp list
# screenshot: node /path/to/index.js - ✔ Connected
```

## Why this is built this way

This repo exists because the "obvious" approaches all failed on a real machine, in ways that are worth knowing about before you try them yourself:

**1. AppleScript / System Events (Accessibility) — dead end.**
The natural way to find a window's bounds or send a keystroke is `osascript -e 'tell application "System Events" to ...'`. This needs the **Accessibility** TCC permission. On the machine this was built on, granting Accessibility to `osascript`, to `node`, and even to the Claude app itself — repeatedly, with toggles, with a full OS restart in between — never actually took effect. We never found out why. If Accessibility works fine for you, great; this repo just doesn't depend on it at all, so you're not blocked either way.

**2. `screencapture -l <windowID>` — only works for the active Space.**
The legacy `screencapture -l` (and the `CGWindowListCreateImage` API behind it) can only capture a window that's actually composited on the **currently active Space**. If an app is running full-screen (which gives it its own dedicated Space — very common for anyone who assigns apps to spaces), or just parked on a Space you're not currently viewing, this fails with a generic `could not create image from window`, indistinguishable from a permissions problem. `list_windows.swift` still uses `CGWindowListCopyWindowInfo` because that part works fine (it only needs Screen Recording) — it's specifically the "image creation" step that's Space-bound.

**3. ScreenCaptureKit — the right tool, with one sharp edge.**
`ScreenCaptureKit` (macOS 12.3+) is Apple's modern capture API and — unlike `-l` — it **can** capture a window regardless of which Space it's on. `capture_window.swift` uses it directly: `SCShareableContent.excludingDesktopWindows(_:onScreenWindowsOnly:)` with `onScreenWindowsOnly: false` finds the window, `SCStream` grabs one frame.

The edge: granting **Screen Recording** to the compiled binary and running it directly (`./capture_window ...`) **silently fails** even after the permission is granted and toggled and the Mac restarted. Packaging the exact same binary inside a minimal signed `.app` bundle didn't fix it either — as long as it was launched by directly exec'ing the Mach-O inside `Contents/MacOS/`. What actually worked: launching that same `.app` bundle through **LaunchServices** — `open -a CaptureWindow.app --args <appName> <outputPath>` — instead of running the embedded binary as a plain child process. Apparently TCC's "is this process really the app it claims to be" check for ScreenCaptureKit wants a real LaunchServices launch, not just a correctly-signed-and-granted binary run from a shell. `index.js` does this for you (`/usr/bin/open -W -a ...`); if you ever touch that code, don't "simplify" it back to a direct exec — it'll quietly stop working.

**If `capture_app_window` ever starts failing with a TCC/`SCStreamErrorDomain Code=-3801` error after you've already granted Screen Recording:** check that it's still going through `open -a`, not a direct binary exec.

## Troubleshooting

- **"No window found matching X"** — the app has no window open right now (minimized, not launched, or genuinely windowless). Open/show it and retry; this is normal, not a bug.
- **`SCStreamErrorDomain Code=-3801`** — Screen Recording isn't granted to `CaptureWindow.app`, or you rebuilt the app (new code signature) and need to re-grant it. Re-run `npm run build` then re-check the permission toggle.
- **Permission toggle "doesn't find" the file in the System Settings picker** — the Screen Recording pane doesn't always expose a working manual file browser on every macOS version. Use `open -R CaptureWindow.app` to reveal it in Finder, then drag it into the Privacy pane's list directly.
- **Tools don't show up in Claude** — a server added via `claude mcp add` only appears in *new* sessions. Restart.

## Repo layout

```
index.js              MCP server (tools: capture_screenshot, capture_app_window, list_windows, system_info)
list_windows.swift     CGWindowList-based window lister (Screen Recording only)
capture_window.swift   ScreenCaptureKit-based single-window capturer (Screen Recording only)
build.sh                Compiles both + packages/signs CaptureWindow.app
```

## License

MIT
