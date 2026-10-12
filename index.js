#!/usr/bin/env node
// MCP server exposing direct screen-capture and system-info tools for this
// machine, so Claude can take screenshots and query real OS/hardware info
// instead of relying on what it's told.
//
// Window-by-app capture has gone through two approaches:
// 1. list_windows (CGWindowListCopyWindowInfo) + `screencapture -l <id>` —
//    works for Screen-Recording-only permission, but only captures windows
//    on the CURRENTLY ACTIVE Space. Full-screen apps each get their own
//    dedicated Space, so this fails for any app not sharing the active one.
// 2. capture_window (ScreenCaptureKit / SCStream) — captures a named app's
//    window directly via the modern capture API, which (unlike -l) is not
//    restricted to the active Space. This is the primary path now; the
//    list_windows/-l path is kept as a fallback for same-space cases.
//
// Accessibility/System Events UI-scripting (used to query window bounds or
// send keystrokes) was tried first and stayed blocked by TCC across repeated
// grants and a full restart, so neither tool depends on it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const LIST_WINDOWS_BIN = path.join(__dirname, "list_windows");
const CAPTURE_WINDOW_APP = path.join(__dirname, "CaptureWindow.app");

const server = new McpServer({
  name: "screenshot",
  version: "2.0.0",
});

async function saveCopy(tmpFile) {
  const destDir = path.join(homedir(), "Desktop", "Screenshots");
  await mkdir(destDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const savedPath = path.join(destDir, `screenshot-${stamp}.png`);
  await execFileAsync("/bin/cp", [tmpFile, savedPath]);
  return savedPath;
}

async function imageResult(tmpFile, tmpDir, savedPath, extraText) {
  let data;
  try {
    data = await readFile(tmpFile);
  } catch {
    await rm(tmpDir, { recursive: true, force: true });
    return {
      isError: true,
      content: [
        { type: "text", text: "No image was produced (capture likely cancelled)." },
      ],
    };
  }
  await rm(tmpDir, { recursive: true, force: true });

  const content = [
    { type: "image", data: data.toString("base64"), mimeType: "image/png" },
  ];
  const text = [
    savedPath ? `Saved to ${savedPath}` : "Not saved to disk (save=false).",
    extraText,
  ]
    .filter(Boolean)
    .join(" — ");
  content.push({ type: "text", text });
  return { content };
}

server.registerTool(
  "capture_screenshot",
  {
    title: "Capture Screenshot",
    description:
      "Takes a screenshot of this Mac directly (full screen, a chosen window via interactive click, or an interactively selected region) using the native screencapture command, and returns the image inline plus the saved file path. For capturing a specific app's window by name without an interactive click, use capture_app_window instead.",
    inputSchema: {
      mode: z
        .enum(["full", "window", "selection"])
        .default("full")
        .describe(
          "full = entire screen; window = user clicks a window to capture; selection = user drags to select a region"
        ),
      delaySeconds: z
        .number()
        .int()
        .min(0)
        .max(30)
        .default(0)
        .describe("Seconds to wait before capturing"),
      save: z
        .boolean()
        .default(true)
        .describe(
          "Whether to also keep a copy in ~/Desktop/Screenshots (in addition to returning it inline)"
        ),
    },
  },
  async ({ mode, delaySeconds, save }) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "screenshot-mcp-"));
    const tmpFile = path.join(tmpDir, "capture.png");

    const args = [];
    if (delaySeconds > 0) args.push("-T", String(delaySeconds));
    if (mode === "window") args.push("-W");
    if (mode === "selection") args.push("-i");
    args.push(tmpFile);

    try {
      await execFileAsync("/usr/sbin/screencapture", args);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `screencapture failed or was cancelled by the user: ${err.message}`,
          },
        ],
      };
    }

    const savedPath = save ? await saveCopy(tmpFile) : null;
    return imageResult(tmpFile, tmpDir, savedPath);
  }
);

server.registerTool(
  "list_windows",
  {
    title: "List Windows",
    description:
      "Lists all on-screen windows (owner app name, window title, id, bounds) via the native CGWindowList API. Only needs Screen Recording permission. Use this to find the right window before calling capture_app_window.",
    inputSchema: {
      ownerFilter: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring to filter by owning app name, e.g. 'filezilla'"
        ),
    },
  },
  async ({ ownerFilter }) => {
    const { stdout } = await execFileAsync(LIST_WINDOWS_BIN);
    let windows = JSON.parse(stdout);
    if (ownerFilter) {
      const needle = ownerFilter.toLowerCase();
      windows = windows.filter((w) =>
        w.ownerName.toLowerCase().includes(needle)
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(windows, null, 2) }],
    };
  }
);

server.registerTool(
  "capture_app_window",
  {
    title: "Capture App Window",
    description:
      "Finds the named app's window via ScreenCaptureKit and captures it directly — no click, no Accessibility needed, and (unlike the legacy screencapture -l path) works even if the window is on a different Space/full-screen desktop than the one currently active. Picks the largest matching window if several match. Fails with a clear message if the app has no window at all right now — ask the user to open it and retry.",
    inputSchema: {
      appName: z
        .string()
        .describe("Case-insensitive substring of the owning app's name, e.g. 'filezilla'"),
      save: z.boolean().default(true),
    },
  },
  async ({ appName, save }) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "screenshot-mcp-"));
    const tmpFile = path.join(tmpDir, "capture.png");

    // Must launch via `open -a` (LaunchServices) rather than exec'ing the
    // embedded binary directly: ScreenCaptureKit's TCC grant for a .app
    // bundle is only honored when the process is launched as a real app,
    // not when its Mach-O is run as a plain child process from a shell.
    try {
      await execFileAsync("/usr/bin/open", [
        "-W",
        "-a",
        CAPTURE_WINDOW_APP,
        "--args",
        appName,
        tmpFile,
      ]);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [{ type: "text", text: `Launch failed: ${err.message}` }],
      };
    }

    let stat;
    try {
      stat = await readFile(tmpFile);
    } catch {
      await rm(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No window found matching "${appName}" (it may not be running or have no open window), or the capture failed.`,
          },
        ],
      };
    }
    void stat;

    const savedPath = save ? await saveCopy(tmpFile) : null;
    return imageResult(tmpFile, tmpDir, savedPath, `Captured window matching "${appName}"`);
  }
);

server.registerTool(
  "system_info",
  {
    title: "System Info",
    description:
      "Queries this Mac directly for its real macOS version, build, and hardware model (sw_vers + system_profiler), instead of relying on assumptions.",
    inputSchema: {},
  },
  async () => {
    const [swVers, hardware] = await Promise.all([
      execFileAsync("/usr/bin/sw_vers").then((r) => r.stdout),
      execFileAsync("/usr/sbin/system_profiler", ["SPHardwareDataType"]).then(
        (r) => r.stdout
      ),
    ]);

    return {
      content: [{ type: "text", text: `${swVers}\n${hardware}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
