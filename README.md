# Claude Browser Bridge

> An Obsidian plugin that lets AI agents (Claude, Playwright, Chrome DevTools MCP, anything that speaks the Chrome DevTools Protocol) drive Obsidian's built-in Web viewer.

You log in to a website once in Obsidian's Web viewer (Gmail, GitHub, Upwork — whatever) and an external AI tool can then drive that tab using your already-authenticated session. No headless browser, no separate authentication, no token storage. The login is yours; the bridge is just an attach point.

Pairs with the [`obsidian-bridge-mcp`](https://github.com/Zbrooklyn/obsidian-bridge-mcp) MCP server, which exposes the bridge to Claude Code (and any other MCP client) as 25 tools — navigate, click, type, screenshot, snapshot, scroll, etc.

---

## How it works

Obsidian is built on Electron. When Electron launches with `--remote-debugging-port=9222`, its embedded Chromium exposes the Chrome DevTools Protocol on `localhost:9222`. Any tool that speaks CDP can attach and drive the Web viewer.

This plugin's job is to make that one launch flag a one-toggle setting:

1. You enable the plugin
2. It scans your Obsidian shortcuts (Desktop, Start Menu, Taskbar pin) and adds `--remote-debugging-port=9222` to each
3. Your next normal Obsidian launch opens the debug port automatically — no special launcher
4. Toggle the plugin off → shortcuts revert cleanly

The plugin itself is small (~600 lines of vanilla JS, no build step). Most of what it does is shortcut management; the actual driving happens via CDP from outside.

## Install (full setup)

Two pieces work together. **You install BOTH for it to work.** Total time ~5 min.

### Prerequisites
- Obsidian (desktop) v1.5.0+
- Node.js v18+ (`node -v` to check) — install from https://nodejs.org
- Git (`git --version` to check)
- Claude Code OR Claude Desktop

### Part 1 — Obsidian plugin (via BRAT)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is the standard installer for Obsidian plugins not yet in the official community store.

1. In Obsidian: **Settings → Community plugins → Browse** → search "BRAT" → **Install + Enable**
2. **Settings → BRAT → "Add Beta plugin"** → paste `Zbrooklyn/obsidian-claude-bridge` → **Add Plugin**
3. **Settings → Community plugins** → toggle **"Claude Browser Bridge"** ON
4. A notice fires: _"patched N Obsidian shortcut(s). Active on next launch."_
5. **Quit and reopen Obsidian** normally. Status bar (bottom-right) should show 🟢 **Bridge active**.

### Part 2 — MCP server (via npm)

In a terminal (PowerShell on Windows, Terminal on Mac/Linux):

```bash
npm install -g github:Zbrooklyn/obsidian-bridge-mcp
```

### Part 3 — Wire into Claude

**For Claude Code** (CLI):

```bash
claude mcp add obsidian-bridge -- obsidian-bridge-mcp
```

Then in any Claude Code session, run `/reload-plugins` — the 25 `obsidian_*` tools appear immediately, no restart needed.

**For Claude Desktop** (GUI), edit your config file:

| OS | Path |
|---|---|
| Mac | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add this entry under `"mcpServers"`:

```json
{
  "mcpServers": {
    "obsidian-bridge": {
      "command": "obsidian-bridge-mcp"
    }
  }
}
```

Save, fully quit and reopen Claude Desktop.

### Part 4 — Verify

Ask Claude:

> Use `obsidian_status` to check the bridge.

You should see `reachable: true` and Chrome version. Done.

> **Need a more detailed walkthrough?** See [INSTALL.md](INSTALL.md) for a step-by-step click-by-click guide including non-technical setup and troubleshooting.

## Install (manual plugin only — if you skip BRAT)

1. Download `main.js`, `manifest.json` from the [latest release](https://github.com/Zbrooklyn/obsidian-claude-bridge/releases)
2. Put both into `<your-vault>/.obsidian/plugins/claude-browser-bridge/`
3. Settings → Community plugins → reload → enable Claude Browser Bridge

(You still need Parts 2-4 above for the MCP server.)

## Settings

Open Settings → Claude Browser Bridge:

- **Bridge enabled** (master toggle) — flip ON to patch shortcuts; flip OFF to revert
- **Debug port** — default `9222`. Change only if it conflicts with another tool
- **Patched shortcuts** — list of which `.lnk` files the plugin modified, with original args saved so the toggle can restore
- **Restart Obsidian to apply bridge now** — optional. Quits and relaunches via a patched shortcut so the bridge activates immediately. Same effect as closing and reopening Obsidian normally — just faster

## Status bar indicator

| State | Meaning |
|---|---|
| 🟢 Bridge active | Debug port is live, AI agents can attach |
| 🟡 Bridge active on next launch | Shortcuts patched, but THIS Obsidian instance was launched without the flag — restart to activate |
| 🔴 Bridge needs setup | Toggle "Bridge enabled" on |
| ⚪ Bridge disabled | You toggled it off |

Click the status bar item to see the list of CDP targets currently visible to external tools.

## Commands

`Ctrl/Cmd+Shift+P` → "Claude Browser Bridge:":

- **Open URL in Web viewer** — prompts for URL, opens in a new Web viewer pane
- **List CDP targets** — shows all attachable targets
- **Check bridge status now** — forces a status poll
- **Restart Obsidian to apply bridge** — quits + relaunches with the flag
- **Enable / Disable bridge** — same as the settings toggle

## Platforms

- ✅ Windows (tested on Win11)
- ⚠️ macOS — should work, shortcut-patching code path is Windows-specific. The bridge mechanism (CDP attach) is platform-agnostic; only the auto-patch step is Windows-only for now. macOS users can manually launch Obsidian with `open -a Obsidian.app --args --remote-debugging-port=9222`. PRs welcome.
- ⚠️ Linux — same as macOS. Manual launch with `obsidian --remote-debugging-port=9222`.
- ❌ Mobile — Obsidian Mobile doesn't run on Electron, no debug port available.

## Privacy & data

- The plugin runs entirely locally. No telemetry, no remote calls beyond polling `localhost:9222` for status.
- The debug port binds only to `127.0.0.1` (localhost) — no LAN exposure unless you explicitly add `--remote-debugging-address=0.0.0.0` (don't do this).
- Patched shortcut paths are stored in `data.json` inside this plugin's folder. That's gitignored and never leaves your machine.

## Troubleshooting

**Status bar stays 🔴 after enabling**
The plugin couldn't find any Obsidian shortcuts to patch. Check Settings → Claude Browser Bridge → "Patched shortcuts" — should list at least one. If empty, your Obsidian shortcuts might be in non-standard locations. Run "Patch shortcuts now" from the command palette to force a re-scan.

**Status bar stays 🟡 forever**
You launched Obsidian via a shortcut the plugin didn't patch (e.g. a custom shortcut elsewhere on disk, or a .desktop file on Linux). Either run "Restart Obsidian to apply bridge" from the command palette, or close + reopen Obsidian via a patched shortcut.

**Plugin slow to load (>30 sec)**
Old issue with v0.2 of the plugin (pre-filtered .lnk scan was slow). Fixed in v0.2.1+. If you're seeing this, you're on an old version — update via BRAT.

**External tool can't see the webview**
Open a Web viewer pane in Obsidian first (Cmd palette → "Web viewer: Open"). The plugin doesn't auto-open one; the bridge only enumerates webviews that exist.

## License

MIT — see LICENSE.
