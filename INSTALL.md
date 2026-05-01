# Install — Claude Browser Bridge + MCP Server

> Two pieces work together: the **Obsidian plugin** (opens the bridge port inside Obsidian) and the **MCP server** (lets Claude talk to the bridge). Total install: ~5 minutes.

---

## Prerequisites

You need these before starting. If you're missing any, install them first:

| Tool | How to check | Where to get it |
|---|---|---|
| **Obsidian** (desktop, v1.5.0+) | open it → ? menu → About | https://obsidian.md/download |
| **Node.js** v18+ | terminal → `node -v` → should print v18.x or higher | https://nodejs.org (LTS recommended) |
| **Git** | terminal → `git --version` | https://git-scm.com/downloads |
| **Claude Code** OR **Claude Desktop** | open the app | https://claude.ai/download |

---

## Quickstart (technical, ~5 min)

### Part 1: Install the Obsidian plugin

In Obsidian:

1. **Settings** → **Community plugins** → **Browse** → search "BRAT" → **Install** + **Enable**
2. **Settings** → **BRAT** → **"Add Beta plugin"** → paste `Zbrooklyn/obsidian-claude-bridge` → **Add Plugin**
3. **Settings** → **Community plugins** → toggle **"Claude Browser Bridge"** ON
4. A notice appears: _"patched N Obsidian shortcut(s). Active on next launch."_
5. **Quit and reopen Obsidian** normally (any shortcut)
6. Status bar (bottom-right) should now show **🟢 Bridge active**

### Part 2: Install the MCP server

In a terminal (PowerShell on Windows, Terminal on Mac/Linux):

```bash
npm install -g github:Zbrooklyn/obsidian-bridge-mcp
```

### Part 3: Wire into your Claude client

#### Option A — Claude Code (CLI users)

```bash
claude mcp add obsidian-bridge -- obsidian-bridge-mcp
```

Then in any Claude Code session, run `/reload-plugins` — the 25 `obsidian_*` tools appear immediately. (No need to restart Claude Code itself.)

#### Option B — Claude Desktop (GUI users)

Edit your Claude Desktop config file:

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

Save the file, fully quit and reopen Claude Desktop. The tools appear in the tool selector.

### Part 4: Verify

Ask Claude:

> Use `obsidian_status` to check the bridge.

Expected output:

```json
{
  "reachable": true,
  "browser": "Chrome/142.0.7444.265",
  "port": 9222,
  "webviewPresent": false
}
```

✅ Done. Try:

> Open `https://news.ycombinator.com` in my Obsidian Web viewer and tell me the top 3 headlines.

You'll watch Claude open a Web viewer pane and read the page live in Obsidian.

---

## Detailed walkthrough (non-technical, ~10 min)

If you've never installed an Obsidian plugin or used a terminal, follow this.

### Step 1: Verify your tools

Open the **Start menu** (Windows) or **Spotlight** (Mac) and search for **"Terminal"** (Mac/Linux) or **"PowerShell"** (Windows). Open it.

Type these one at a time, pressing Enter after each:

```
node -v
git --version
```

If both print version numbers, skip ahead to Step 2.
If either says "command not found" or "not recognized", install the missing one from the Prerequisites table above, then come back.

### Step 2: Install the BRAT plugin in Obsidian

BRAT is the standard tool for installing Obsidian plugins that aren't in the official store yet.

1. Open Obsidian.
2. Click the gear icon (bottom-left) → **Settings**.
3. In the left sidebar, click **Community plugins**.
4. If you see "Community plugins are currently disabled," click **Turn on community plugins**.
5. Click the **Browse** button.
6. In the search box, type `BRAT`.
7. Click on **"BRAT"** by TfTHacker → click **Install**.
8. After it installs, click **Enable**.
9. Close the plugin browser (X button or click outside).

You should now see "BRAT" in your left sidebar of Settings.

### Step 3: Install Claude Browser Bridge via BRAT

1. Still in Settings, click **BRAT** in the left sidebar.
2. Click the button **"Add Beta plugin"**.
3. A box appears asking for the GitHub repository. Paste:
   ```
   Zbrooklyn/obsidian-claude-bridge
   ```
4. Click **Add Plugin**. Wait a few seconds — BRAT downloads the plugin from GitHub.
5. Go back to **Settings** → **Community plugins**.
6. Find **"Claude Browser Bridge"** in the list. Toggle the switch ON (the toggle on the right).
7. **A notice will pop up** at the bottom of Obsidian: _"Claude Browser Bridge enabled. N Obsidian shortcut(s) updated. The bridge will be active the next time you launch Obsidian."_

What just happened: the plugin found your Obsidian shortcuts (Desktop icon, Start Menu entry, Taskbar pin) and added a launch flag (`--remote-debugging-port=9222`) to each. Next time you start Obsidian, this opens a "debug port" that AI tools can connect to.

### Step 4: Restart Obsidian

Fully quit Obsidian (File → Quit, or Cmd/Ctrl+Q). Then reopen it via your normal shortcut.

Look at the bottom-right corner of Obsidian. You should see a small green dot icon with the text:

> 🟢 Bridge active

If you see this, the bridge is working. If you see 🟡 instead ("active on next launch"), quit and reopen one more time — it means you used a shortcut the plugin didn't update.

### Step 5: Install the MCP server

Open your terminal again (PowerShell on Windows, Terminal on Mac).

Type this exactly:

```
npm install -g github:Zbrooklyn/obsidian-bridge-mcp
```

Press Enter. You'll see download progress. After ~30 seconds, you should see something like:

```
added 91 packages in 12s
```

That installed the MCP server globally on your machine. To verify, type:

```
obsidian-bridge-mcp --help
```

It should print some help text. If you get "command not found", restart your terminal and try again — npm sometimes needs a fresh shell to pick up newly installed binaries.

### Step 6: Tell Claude about the new tool

#### If you use Claude Code (the terminal version)

Type this in your terminal:

```
claude mcp add obsidian-bridge -- obsidian-bridge-mcp
```

Press Enter. You should see "Added stdio MCP server" or similar.

Then in any Claude Code session, type `/reload-plugins` and press Enter. The new tools appear immediately — no need to restart Claude Code itself.

#### If you use Claude Desktop (the app version)

You need to edit a configuration file. Don't worry — it's just one paragraph of text.

**On Mac:**

1. Open Finder. Press Cmd+Shift+G to "Go to folder".
2. Paste: `~/Library/Application Support/Claude/`
3. Find the file `claude_desktop_config.json`. Right-click → Open With → TextEdit.

**On Windows:**

1. Open File Explorer. Click the address bar.
2. Paste: `%APPDATA%\Claude\`
3. Find `claude_desktop_config.json`. Right-click → Open With → Notepad.

The file might look like this (or it might be nearly empty):

```json
{
  "mcpServers": {
    "some-other-server": {
      "command": "..."
    }
  }
}
```

Add this entry inside `"mcpServers"`:

```json
"obsidian-bridge": {
  "command": "obsidian-bridge-mcp"
}
```

If the file was empty or just `{}`, paste this entire thing instead:

```json
{
  "mcpServers": {
    "obsidian-bridge": {
      "command": "obsidian-bridge-mcp"
    }
  }
}
```

Save the file. Fully quit Claude Desktop (right-click the icon in the tray → Quit, or use Cmd+Q on Mac) and reopen it.

### Step 7: Verify it works

Open Claude Code or Claude Desktop. Start a new chat. Ask Claude:

> Use the obsidian_status tool to check the bridge.

If it works, Claude will respond with something like:

```json
{
  "reachable": true,
  "browser": "Chrome/142.0.7444.265",
  "port": 9222,
  "webviewPresent": false
}
```

Now try a real task:

> Open https://news.ycombinator.com in my Obsidian Web viewer and tell me the top 3 headlines.

You'll watch Claude open a tab inside your Obsidian and read it live. That's the bridge working.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Status bar 🔴 "Bridge needs setup" | Open Settings → Claude Browser Bridge → toggle "Bridge enabled" ON. |
| Status bar 🟡 "active on next launch" | Quit and reopen Obsidian via any patched shortcut. If it stays yellow, run Cmd/Ctrl-Shift-P → "Claude Browser Bridge: Restart Obsidian to apply bridge". |
| `obsidian_status` returns `reachable: false` | Obsidian isn't running, OR you launched it via a shortcut the plugin didn't patch. Check status bar in Obsidian first. |
| `npm install -g github:...` fails with "permission denied" | On Mac/Linux, prefix with `sudo`. On Windows, run terminal as Administrator. |
| `obsidian-bridge-mcp: command not found` | Restart your terminal — npm sometimes needs a fresh shell. If still broken: `npm config get prefix` to see where global binaries went; make sure that path is in your PATH. |
| Tools don't appear in Claude after restart | Run `claude mcp list` (Code) — should show `obsidian-bridge`. If yes but tools missing, restart Claude. If no, run `claude mcp add` again. For Desktop: re-check your `claude_desktop_config.json` JSON for syntax errors (no trailing commas). |
| Plugin slow to enable (>30 seconds) | You're on an old version. BRAT settings → "Check for updates". v0.2.1+ fixed the slow-scan bug. |
| Cloudflare error on a website | Some sites refuse to load in Obsidian's webview because of how its DNS resolution looks (Cloudflare error 1002). Use a regular browser MCP for those specific sites. |

---

## What you're trusting

- The plugin runs entirely on your computer. No telemetry, no data leaves your machine.
- The "debug port" only listens on `127.0.0.1` (localhost) — not exposed to your network.
- Your Obsidian Web viewer's cookies stay where they always were (Obsidian's local data folder).
- The MCP server only connects to `localhost:9222` and only operates on the Web viewer tabs Obsidian shows. It does not spawn its own browser.

You're trusting one Obsidian plugin (~600 lines of JS, source on GitHub) and one MCP server (~900 lines of JS, source on GitHub). Both are MIT-licensed and reviewable before you install.

---

## Uninstall

To fully remove everything:

1. **Plugin:** Obsidian → Settings → Community plugins → toggle "Claude Browser Bridge" OFF (this restores your shortcuts to original). Click 🗑 to fully delete.
2. **MCP server:** terminal → `npm uninstall -g obsidian-bridge-mcp`
3. **Claude config:**
   - Code: `claude mcp remove obsidian-bridge`
   - Desktop: edit the config file, remove the `"obsidian-bridge"` entry, save, restart.

That's it. Your shortcuts revert; nothing residual.
