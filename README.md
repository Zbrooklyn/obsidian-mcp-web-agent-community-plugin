# Claude Browser Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/github/manifest-json/v/Zbrooklyn/obsidian-claude-bridge?label=version)](https://github.com/Zbrooklyn/obsidian-claude-bridge/releases)
[![Stars](https://img.shields.io/github/stars/Zbrooklyn/obsidian-claude-bridge?style=social)](https://github.com/Zbrooklyn/obsidian-claude-bridge/stargazers)

Let Claude (or any AI agent) drive a browser tab inside Obsidian, using websites you're already logged into.

> _Demo screenshot goes here. Capture your status bar showing 🟢 Bridge active plus the Web viewer mid-task. Save as `docs/demo.png` and replace this line with `![demo](docs/demo.png)`._

## What it actually does

You sign into Gmail (or anything else) once, in Obsidian's built-in Web viewer. From then on, you can ask Claude things like "open my inbox and tell me what's worth replying to today," and Claude does it. Inside Obsidian. Using your real session.

The trick: nothing fancy. Obsidian is built on the same engine as Chrome, and Chrome has a built-in protocol for letting other programs control it. This plugin flips that switch. Once it's on, any AI tool that knows the protocol can drive your Web viewer.

The login stays yours. No password lives in Claude's memory, no token gets stored anywhere new, no separate browser opens up next to Obsidian. You watch everything happen in the panel you already use every day.

## What you'd use it for

A few real things people are doing with it:

- **Triage Gmail without handing Claude your password.** Sign in once, ask Claude to scan unread, draft replies, archive newsletters. The AI sees what you see; it doesn't see your credentials.
- **Read an article, write the note.** "Open this URL and write me a summary as a vault note." Claude reads the page in the Web viewer and writes straight into your vault. One window the whole time.
- **Drive any logged-in dashboard.** Stripe, Vercel, GitHub, Upwork, Shopify Admin. If you're authenticated in the browser, you can ask Claude to pull data, fill forms, run reports.
- **Test your own web apps.** Localhost dashboards, internal tools, prototypes. Claude can navigate them via the bridge while you watch.

The pattern: anywhere you find yourself copying things between a browser tab and Claude, this removes the copying.

## Install

Two pieces. The Obsidian plugin opens the door; the MCP server lets Claude walk through it. Total setup: about five minutes.

### What you'll need

- Obsidian (desktop, v1.5.0+)
- Node.js v18 or higher (`node -v` to check, install from [nodejs.org](https://nodejs.org) if missing)
- Git (`git --version`)
- Claude Code or Claude Desktop

### 1. Install the plugin via BRAT

In Obsidian: **Settings → Community plugins → Browse**, search for "BRAT", install it, enable it. Then **Settings → BRAT → Add Beta plugin**, paste `Zbrooklyn/obsidian-claude-bridge`, click Add. Finally, **Settings → Community plugins**, toggle "Claude Browser Bridge" on.

A notice will pop up: _"patched N Obsidian shortcut(s). Active on next launch."_ The plugin just added a launch flag to your Obsidian shortcuts. Quit Obsidian and reopen it normally. Status bar (bottom-right) should show 🟢 Bridge active.

### 2. Install the MCP server

In a terminal:

```bash
npm install -g github:Zbrooklyn/obsidian-bridge-mcp
```

### 3. Tell Claude about it

If you use **Claude Code**:

```bash
claude mcp add obsidian-bridge -- obsidian-bridge-mcp
```

Then in any active Claude Code session, run `/reload-plugins`. Tools appear instantly.

If you use **Claude Desktop**, edit your config:

| OS | Path |
|---|---|
| Mac | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add this under `"mcpServers"`:

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

### 4. Try it

Ask Claude:

> Use `obsidian_status` to check the bridge.

You should get back `reachable: true` and your Chrome version. Then try something real:

> Open `https://news.ycombinator.com` in my Obsidian Web viewer and tell me the top 3 headlines.

You'll watch Claude drive the tab live.

Need a click-by-click walkthrough? See [INSTALL.md](INSTALL.md).

## FAQ

**Does this work with Claude Desktop?**
Yes. Same MCP server, different config file (see install step 3 above).

**Is my data safe?**
The plugin runs entirely on your computer. The debug port only listens on `127.0.0.1` (localhost), not your network. Cookies stay where they always were, in Obsidian's local Electron session. Nothing leaves your machine.

**Why not just use Playwright MCP or Chrome DevTools MCP?**
Those spawn their own browser. Different cookies, different logins, doesn't reuse anything you've already authenticated with. The whole point of this is reusing your Obsidian session. If you don't need that, the others are great. (And you can run all of them at once. They don't conflict.)

**Will this slow down Obsidian?**
The plugin itself is small and barely runs. The Web viewer can be slow when loading heavy sites like Gmail, but that's the site's weight, not the plugin's.

**The plugin isn't in the official Obsidian community store. Is it official?**
Not yet. This is a beta release, distributed via BRAT. If usage and stability hold up, official store submission is the next step.

---

<details>
<summary><b>How it actually works (technical)</b></summary>

Obsidian is an Electron app, which means the Web viewer is a Chromium webview. When Electron is launched with `--remote-debugging-port=9222`, that Chromium exposes the Chrome DevTools Protocol on `localhost:9222`. Anything that speaks CDP (Playwright, Chrome DevTools MCP, raw `chrome-remote-interface`, this plugin's MCP server) can attach and drive it.

This plugin's job is making the launch flag a one-toggle setting:

1. You enable the plugin
2. It scans your Obsidian shortcuts (Desktop, Start Menu, Taskbar pin) and adds `--remote-debugging-port=9222` to each, saving the original args so the toggle can revert
3. Your next normal launch opens the debug port automatically
4. Toggle the plugin off and the shortcuts revert cleanly

The plugin is about 600 lines of vanilla JavaScript, no build step. Most of it is the shortcut-management logic; the actual driving happens via CDP from outside.

</details>

<details>
<summary><b>Settings, commands, and the status bar</b></summary>

### Settings (Obsidian → Settings → Claude Browser Bridge)

- **Bridge enabled** — master toggle. ON patches your shortcuts, OFF reverts them.
- **Debug port** — defaults to 9222. Change only if it conflicts with another tool you run.
- **Patched shortcuts** — list of `.lnk` files the plugin modified, with original args saved.
- **Restart Obsidian to apply bridge** — quits and relaunches via a patched shortcut. Same effect as you closing and reopening normally, just faster.

### Status bar indicator

| State | Meaning |
|---|---|
| 🟢 Bridge active | Debug port is live, AI agents can attach |
| 🟡 Bridge active on next launch | Shortcuts are patched, but THIS Obsidian instance was launched without the flag. Restart. |
| 🔴 Bridge needs setup | Toggle "Bridge enabled" on. |
| ⚪ Bridge disabled | You toggled it off. |

### Commands (Cmd/Ctrl-Shift-P → "Claude Browser Bridge:")

- Open URL in Web viewer
- List CDP targets
- Check bridge status now
- Restart Obsidian to apply bridge
- Enable / Disable bridge

</details>

<details>
<summary><b>Comparison vs other browser MCPs</b></summary>

| Tool | What it drives | When to use |
|---|---|---|
| **claude-browser-bridge** + obsidian-bridge-mcp | Obsidian's Web viewer (your real session) | Logged-in personal sessions; results land in your vault |
| [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Fresh Chromium spawned by the MCP | Anonymous browsing, parallel contexts |
| [@playwright/mcp](https://github.com/microsoft/playwright-mcp) | Playwright-managed browsers | Headless mode, cross-browser testing |
| [browsermcp](https://browsermcp.io) | Your actual desktop Chrome via extension | Driving the browser you already use |

These complement each other. Many users run several at once. The routing pattern: bridge for personal logged-in stuff, the others for fresh anonymous work.

</details>

<details>
<summary><b>Platforms and known limits</b></summary>

### Platforms

- **Windows** — fully supported, tested on Win11
- **macOS** — bridge mechanism works, but the auto-patch step is Windows-specific. Mac users launch Obsidian with `open -a Obsidian.app --args --remote-debugging-port=9222`. PRs welcome to add Mac auto-patch.
- **Linux** — same as macOS. Manual launch with `obsidian --remote-debugging-port=9222`.
- **Mobile** — not supported. Obsidian Mobile doesn't run on Electron, so there's no debug port to expose.

### Privacy

- Plugin runs entirely locally. No telemetry.
- Debug port binds to `127.0.0.1` (localhost) only, unless you explicitly add `--remote-debugging-address=0.0.0.0` (don't).
- Patched shortcut paths are stored in `data.json` inside the plugin folder. That file is gitignored and never leaves your machine.
- The MCP server only connects to `localhost:9222` and only operates on Web viewer tabs. It does not spawn its own browser, does not touch your Chrome profile, does not affect other browser MCPs.

### Known issues

- **Cloudflare error 1002 on some sites** — Cloudflare refuses to load some sites in Obsidian's webview because of how its DNS resolution looks. Not a plugin bug. Use a regular browser MCP for those specific sites.
- **Plugin slow to enable on old versions** — pre-v0.2.1 had a slow shortcut scan. If you see >30s enable times, update via BRAT.
- **Sometimes you need to restart Obsidian twice after first install** — if the status bar stays yellow after one restart, run "Restart Obsidian to apply bridge" from the command palette.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

**Status bar stays 🔴 after enabling.** The plugin couldn't find shortcuts. Settings → Claude Browser Bridge → "Patched shortcuts" should list at least one. If empty, your shortcuts are in a non-standard location. Run "Patch shortcuts now" from the command palette to force a re-scan.

**Status bar stays 🟡 forever.** You launched Obsidian via a shortcut the plugin didn't patch. Either run "Restart Obsidian to apply bridge" from the command palette, or close and reopen Obsidian via a patched shortcut.

**External tool can't see the webview.** Open a Web viewer pane in Obsidian first (Cmd palette → "Web viewer: Open"). The plugin doesn't auto-open one; the bridge only enumerates webviews that exist.

**Tools don't appear in Claude after install.** For Claude Code, run `claude mcp list` to confirm `obsidian-bridge` is registered, then `/reload-plugins` in any session. For Claude Desktop, check `claude_desktop_config.json` for syntax errors (no trailing commas) and fully quit + reopen.

</details>

<details>
<summary><b>Roadmap</b></summary>

**Planned:**
- Cross-platform shortcut patching (macOS .desktop equivalents, Linux .desktop files)
- One-line installer that handles both plugin and MCP server in one command
- Submission to the official Obsidian community store
- Demo videos

**Maybe (open to discussion via Issues):**
- Per-tab visual badge in Obsidian showing which Web viewer Claude is currently driving
- Webhook subscription so external tools can react to navigations
- Per-tab cookie isolation

**Not in scope:**
- Replacing your actual browser. This is a complement, not a replacement.
- Mobile support. Obsidian Mobile isn't Electron.
- Headless mode. Obsidian is always headed by design.

</details>

## Contributing

Issues and PRs welcome at https://github.com/Zbrooklyn/obsidian-claude-bridge/issues.

For PRs: open an issue first to discuss. Match the existing code style (vanilla JS, no build step, idiomatic Obsidian Plugin API). Test on your own vault. Update the README and INSTALL.md if your change affects user-facing behavior.

For bug reports, include: Obsidian version, plugin version, OS, what you ran, what you expected, what happened, and the status bar state at the time.

## Acknowledgments

Built on:
- [Obsidian](https://obsidian.md) and its plugin API
- The [Model Context Protocol](https://modelcontextprotocol.io/) and the [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) for beta plugin distribution
- The Chrome DevTools Protocol

Inspired by other "AI inside Obsidian" plugins, each doing a different piece:
- [Claudian](https://github.com/YishenTu/claudian) (Claude Code as sidebar chat)
- [obsidian-mind](https://github.com/breferrari/obsidian-mind) (vault as persistent memory for AI agents)
- [obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) (Agent Client Protocol bridge)

This plugin's contribution is the browser bridge specifically.

## License

MIT — see [LICENSE](LICENSE).
