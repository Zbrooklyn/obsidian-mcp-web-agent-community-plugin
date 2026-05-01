'use strict';

const { Plugin, Modal, Notice, requestUrl, PluginSettingTab, Setting } = require('obsidian');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 9222;
const POLL_INTERVAL_MS = 5000;
const FLAG_PREFIX = '--remote-debugging-port=';
const PS = 'powershell.exe';

// ─── Shortcut helpers (Windows only) ─────────────────────────────────────────

function isWindows() {
  return process.platform === 'win32';
}

function listLnksRecursive(dir, depth = 2, nameFilter = null) {
  // nameFilter: optional regex applied to basename (without .lnk) to skip files cheaply.
  const out = [];
  if (!dir || depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listLnksRecursive(full, depth - 1, nameFilter));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.lnk')) {
      if (nameFilter) {
        const base = ent.name.slice(0, -4);
        if (!nameFilter.test(base)) continue;
      }
      out.push(full);
    }
  }
  return out;
}

function readShortcut(lnkPath) {
  // Returns { TargetPath, Arguments } or null on failure.
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); @{TargetPath=$s.TargetPath;Arguments=$s.Arguments} | ConvertTo-Json -Compress`;
  try {
    const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5000,
    });
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

function writeShortcutArgs(lnkPath, newArgs) {
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.Arguments = '${newArgs.replace(/'/g, "''")}'; $s.Save()`;
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 5000,
  });
}

function findUserObsidianShortcuts() {
  // v0.2.2: extended scan — added Taskbar and StartMenu pinned locations.
  // v0.2.1 missed the Taskbar pin which is what most users launch Obsidian from.
  if (!isWindows()) return [];
  const home = process.env.USERPROFILE || '';
  const appData = process.env.APPDATA || '';
  const dirs = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch'),
  ].filter(Boolean);

  const nameFilter = /obsidian/i;
  const lnks = [];
  for (const d of dirs) lnks.push(...listLnksRecursive(d, 2, nameFilter));

  // Dedupe by absolute path (some pinned shortcuts can appear in multiple traversal roots).
  const seen = new Set();
  const unique = [];
  for (const l of lnks) {
    const k = l.toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(l); }
  }
  lnks.length = 0;
  lnks.push(...unique);

  const matched = [];
  for (const lnk of lnks) {
    const sc = readShortcut(lnk);
    if (!sc) continue;
    if ((sc.TargetPath || '').toLowerCase().endsWith('obsidian.exe')) {
      matched.push({ path: lnk, target: sc.TargetPath, args: sc.Arguments || '' });
    }
  }
  return matched;
}

function ensureFlagInArgs(args, port) {
  // Strip any existing --remote-debugging-port=*, then append our flag.
  const stripped = (args || '').replace(/\s*--remote-debugging-port=\d+/g, '').trim();
  return (stripped + ' ' + FLAG_PREFIX + port).trim();
}

function stripFlagFromArgs(args) {
  return (args || '').replace(/\s*--remote-debugging-port=\d+/g, '').trim();
}

function argsAlreadyHaveFlag(args, port) {
  return new RegExp(`(^|\\s)${FLAG_PREFIX}${port}(\\s|$)`).test(args || '');
}

// ─── Modals ─────────────────────────────────────────────────────────────────

class CdpTargetsModal extends Modal {
  constructor(app, targets, port) {
    super(app); this.targets = targets; this.port = port;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `CDP Targets on :${this.port}` });
    if (!Array.isArray(this.targets)) {
      contentEl.createEl('p', {
        text: 'Bridge is not active in this Obsidian session. Your shortcuts are configured — close and reopen Obsidian normally to activate, or use "Restart Obsidian to apply bridge" from the command palette to activate right now.',
      });
      return;
    }
    if (!this.targets.length) {
      contentEl.createEl('p', { text: 'Bridge open but reports zero targets.' });
      return;
    }
    contentEl.createEl('p', { text: `${this.targets.length} target(s) visible to external CDP clients:`, cls: 'setting-item-description' });
    const table = contentEl.createEl('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
    const head = table.createEl('thead').createEl('tr');
    ['Type', 'Title', 'URL'].forEach((h) => {
      const th = head.createEl('th', { text: h });
      th.style.cssText = 'text-align:left;padding:4px 8px;border-bottom:1px solid var(--background-modifier-border);';
    });
    const tbody = table.createEl('tbody');
    for (const t of this.targets) {
      const row = tbody.createEl('tr');
      ['type', 'title', 'url'].forEach((k) => {
        const v = k === 'type' ? (t.type || '?') : (t[k] || (k === 'title' ? '(untitled)' : '')).slice(0, 80);
        const td = row.createEl('td', { text: v });
        td.style.cssText = 'padding:4px 8px;border-bottom:1px solid var(--background-modifier-border);';
        if (t.type === 'webview') td.style.fontFamily = 'var(--font-monospace)';
      });
      if (t.type === 'webview') {
        row.style.background = 'var(--background-modifier-success)';
        row.setAttr('title', 'Web viewer — Claude/CDP can drive this.');
      }
    }
  }
  onClose() { this.contentEl.empty(); }
}

class OpenUrlModal extends Modal {
  constructor(app, onSubmit) { super(app); this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Open URL in Web viewer' });
    const input = contentEl.createEl('input', { type: 'text', placeholder: 'https://example.com' });
    input.style.cssText = 'width:100%;padding:8px;margin-bottom:12px;';
    input.value = 'https://';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const submit = () => {
      const url = input.value.trim();
      if (!url || url === 'https://') return new Notice('Enter a URL');
      this.close(); this.onSubmit(url);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') this.close(); });
    const btn = contentEl.createEl('button', { text: 'Open', cls: 'mod-cta' });
    btn.addEventListener('click', submit);
  }
  onClose() { this.contentEl.empty(); }
}

class RestartConfirmModal extends Modal {
  constructor(app, shortcut, port, onConfirm) {
    super(app); this.shortcut = shortcut; this.port = port; this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Restart Obsidian to apply bridge?' });
    contentEl.createEl('p', { text: 'Obsidian will quit and relaunch via:' });
    const code = contentEl.createEl('code', { text: this.shortcut || '(no patched shortcut found)' });
    code.style.cssText = 'display:block;padding:8px;background:var(--background-modifier-form-field);border-radius:4px;margin:8px 0;';
    contentEl.createEl('p', {
      text: `The new instance will listen for CDP connections on port ${this.port}.`,
      cls: 'setting-item-description',
    });
    const btnRow = contentEl.createEl('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const cancel = btnRow.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const confirm = btnRow.createEl('button', { text: 'Restart now', cls: 'mod-cta' });
    confirm.disabled = !this.shortcut;
    confirm.addEventListener('click', () => { this.close(); this.onConfirm(); });
  }
  onClose() { this.contentEl.empty(); }
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

const DEFAULT_DATA = {
  port: DEFAULT_PORT,
  // Master switch — user's desired state for the bridge.
  // null = first-run (auto-enable), true = enabled, false = explicitly disabled.
  enabled: null,
  patched: false,
  patchedShortcuts: [], // [{ path, originalArgs }]
};

module.exports = class ClaudeBridgePlugin extends Plugin {
  async onload() {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.lastStatus = null;
    this.lastBrowser = '';

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.addEventListener('click', () => this.openTargetsModal());
    this.renderStatus(null);

    this.pollStatus();
    this.registerInterval(window.setInterval(() => this.pollStatus(), POLL_INTERVAL_MS));

    // Reconcile bridge state with user's desired toggle. Deferred so it doesn't block onload.
    // - First run (enabled === null): auto-enable, patch shortcuts, show welcome.
    // - User wants enabled (enabled === true) but shortcuts not patched: patch.
    // - User wants disabled (enabled === false) but shortcuts still patched: restore.
    // - Steady state: do nothing.
    if (isWindows()) {
      setTimeout(async () => {
        try {
          await this.reconcileBridgeState();
        } catch (e) {
          console.error('[obsidian-mcp-web-agent] reconcile error', e);
        }
      }, 1500);
    }

    this.addCommand({
      id: 'open-url-in-webviewer',
      name: 'Open URL in Web viewer',
      callback: () => new OpenUrlModal(this.app, (url) => this.openInWebviewer(url)).open(),
    });
    this.addCommand({
      id: 'list-cdp-targets',
      name: 'List CDP targets',
      callback: () => this.openTargetsModal(),
    });
    this.addCommand({
      id: 'check-bridge-status',
      name: 'Check bridge status now',
      callback: async () => {
        await this.pollStatus();
        const msg = this.lastStatus
          ? `Bridge active on :${this.data.port}. ${this.lastBrowser}`
          : `Bridge unreachable on :${this.data.port}.`;
        new Notice(msg);
      },
    });
    this.addCommand({
      id: 'restart-with-bridge',
      name: 'Restart Obsidian to apply bridge',
      callback: () => this.restartObsidian(),
    });
    this.addCommand({
      id: 'enable-bridge',
      name: 'Enable bridge',
      callback: () => this.setEnabled(true),
    });
    this.addCommand({
      id: 'disable-bridge',
      name: 'Disable bridge (restore original shortcuts)',
      callback: () => this.setEnabled(false),
    });

    this.addSettingTab(new ClaudeBridgeSettingTab(this.app, this));

    console.log('[obsidian-mcp-web-agent] loaded; patched=', this.data.patched);
  }

  onunload() {
    // Intentional no-op: we do NOT auto-restore on unload because Obsidian calls
    // onunload both for "user disabled the plugin" AND for "Obsidian is quitting".
    // To fully revert, run "Restore Obsidian shortcuts" then disable the plugin.
    console.log('[obsidian-mcp-web-agent] unloaded');
  }

  // ── Bridge state reconciliation ────────────────────────────────────────────

  async reconcileBridgeState() {
    const wantEnabled = this.data.enabled;

    if (wantEnabled === null) {
      // First run — auto-enable as a default.
      const patched = await this.patchShortcuts();
      this.data.enabled = true;
      await this.saveData(this.data);
      if (patched.length > 0) {
        new Notice(
          `Claude Browser Bridge enabled.\n\n` +
          `${patched.length} Obsidian shortcut(s) updated. The bridge will be active the next time you launch Obsidian — no special action needed, just close and reopen normally when you're ready.\n\n` +
          `(If you want to disable later, toggle "Bridge enabled" off in settings — that reverts the shortcuts.)`,
          12000
        );
      }
      return;
    }

    if (wantEnabled === true && !this.data.patched) {
      // User wants enabled but state drifted (e.g. they ran Restore manually then re-enabled). Re-patch.
      const patched = await this.patchShortcuts();
      if (patched.length > 0) console.log(`[obsidian-mcp-web-agent] re-patched ${patched.length} shortcut(s)`);
      return;
    }

    if (wantEnabled === false && this.data.patched && (this.data.patchedShortcuts || []).length > 0) {
      // User toggled off in settings — restore.
      const n = await this.restoreShortcuts();
      if (n > 0) console.log(`[obsidian-mcp-web-agent] restored ${n} shortcut(s)`);
      return;
    }
  }

  async setEnabled(wantEnabled) {
    if (wantEnabled === !!this.data.enabled) return; // no-op
    if (wantEnabled) {
      this.data.enabled = true;
      await this.saveData(this.data);
      const patched = await this.patchShortcuts();
      new Notice(
        patched.length > 0
          ? `Bridge enabled. ${patched.length} shortcut(s) updated. Active on next Obsidian launch.`
          : `Bridge enabled.`
      );
    } else {
      const restored = await this.restoreShortcuts();
      this.data.enabled = false;
      await this.saveData(this.data);
      new Notice(
        restored > 0
          ? `Bridge disabled. Restored ${restored} shortcut(s). Bridge stops working after your next normal Obsidian launch.`
          : `Bridge disabled.`
      );
    }
    await this.pollStatus();
  }

  // ── Shortcut management ────────────────────────────────────────────────────

  async patchShortcuts() {
    if (!isWindows()) {
      new Notice('Shortcut patching only supported on Windows for v0.2.');
      return [];
    }
    const found = findUserObsidianShortcuts();
    const patched = [];
    for (const sc of found) {
      if (argsAlreadyHaveFlag(sc.args, this.data.port)) continue;
      const original = sc.args;
      const newArgs = ensureFlagInArgs(sc.args, this.data.port);
      try {
        writeShortcutArgs(sc.path, newArgs);
        patched.push({ path: sc.path, originalArgs: original });
      } catch (e) {
        console.error('[obsidian-mcp-web-agent] failed to patch', sc.path, e);
      }
    }
    if (patched.length > 0) {
      // Merge into existing record (preserve originals from previous patches).
      const existingPaths = new Set((this.data.patchedShortcuts || []).map((s) => s.path));
      for (const p of patched) if (!existingPaths.has(p.path)) this.data.patchedShortcuts.push(p);
      this.data.patched = true;
      await this.saveData(this.data);
    }
    return patched;
  }

  async restoreShortcuts() {
    if (!isWindows()) return 0;
    let count = 0;
    for (const rec of (this.data.patchedShortcuts || [])) {
      try {
        writeShortcutArgs(rec.path, rec.originalArgs || '');
        count++;
      } catch (e) {
        console.error('[obsidian-mcp-web-agent] failed to restore', rec.path, e);
      }
    }
    this.data.patchedShortcuts = [];
    this.data.patched = false;
    await this.saveData(this.data);
    return count;
  }

  pickRestartShortcut() {
    // Prefer Desktop shortcut for visible relaunch path.
    const list = this.data.patchedShortcuts || [];
    const desktop = list.find((s) => s.path.toLowerCase().includes('\\desktop\\'));
    return (desktop || list[0] || {}).path || null;
  }

  async restartObsidian() {
    const sc = this.pickRestartShortcut();
    new RestartConfirmModal(this.app, sc, this.data.port, () => {
      if (!sc) {
        new Notice('No patched shortcut found. Run "Patch Obsidian shortcuts now" first.');
        return;
      }
      try {
        // Spawn detached helper that waits then launches the patched shortcut.
        const ps = `Start-Sleep -Seconds 2; Start-Process -FilePath "${sc.replace(/"/g, '\\"')}"`;
        spawn(PS, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
          detached: true, stdio: 'ignore',
        }).unref();
        // Then trigger Obsidian's quit.
        this.app.commands.executeCommandById('app:quit');
      } catch (e) {
        new Notice('Restart failed: ' + (e.message || e));
        console.error('[obsidian-mcp-web-agent] restart error', e);
      }
    }).open();
  }

  // ── CDP polling ────────────────────────────────────────────────────────────

  async pollStatus() {
    try {
      const res = await requestUrl({ url: `http://127.0.0.1:${this.data.port}/json/version`, method: 'GET', throw: false });
      if (res.status >= 200 && res.status < 300 && res.json) {
        this.lastStatus = true;
        this.lastBrowser = res.json.Browser || '';
        this.renderStatus(true);
        return;
      }
    } catch (e) { /* fall through */ }
    this.lastStatus = false;
    this.lastBrowser = '';
    this.renderStatus(false);
  }

  renderStatus(active) {
    const el = this.statusBarItem;
    if (!el) return;

    // User explicitly toggled the bridge off — state takes priority over port-reachability.
    if (this.data.enabled === false) {
      el.setText('⚪ Bridge disabled');
      el.setAttribute('aria-label', `Bridge is disabled. Toggle it back on in plugin settings.`);
      return;
    }

    if (active === true) {
      el.setText(`🟢 Bridge active`);
      el.setAttribute('aria-label', `Claude Browser Bridge is active on port ${this.data.port}. ${this.lastBrowser}\n\nClick to see what AI agents can drive.`);
    } else if (active === false) {
      if (this.data.patched && (this.data.patchedShortcuts || []).length > 0) {
        el.setText('🟡 Bridge active on next launch');
        el.setAttribute(
          'aria-label',
          `Your Obsidian shortcuts are configured. The bridge will be active next time you launch Obsidian — no special action needed.\n\nClose and reopen Obsidian normally when you're ready, or use "Restart Obsidian to apply bridge" from the command palette to activate now.`
        );
      } else {
        el.setText('🔴 Bridge needs setup');
        el.setAttribute('aria-label', `Bridge not yet configured. Open plugin settings and toggle "Bridge enabled" on.`);
      }
    } else {
      el.setText('⚪ Bridge ?');
      el.setAttribute('aria-label', 'Checking bridge status...');
    }
  }

  async fetchTargets() {
    try {
      const res = await requestUrl({ url: `http://127.0.0.1:${this.data.port}/json`, method: 'GET', throw: false });
      if (res.status >= 200 && res.status < 300 && Array.isArray(res.json)) return res.json;
    } catch (e) { /* fall through */ }
    return null;
  }

  async openTargetsModal() {
    const targets = await this.fetchTargets();
    new CdpTargetsModal(this.app, targets, this.data.port).open();
  }

  async openInWebviewer(url) {
    try {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } });
      this.app.workspace.revealLeaf(leaf);
      new Notice(`Web viewer → ${url}`);
    } catch (e) {
      new Notice(`Failed to open Web viewer: ${e.message || e}`);
    }
  }
};

// ─── Settings tab ───────────────────────────────────────────────────────────

class ClaudeBridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claude Browser Bridge' });

    // ── Master toggle (lives at the top, primary control) ──
    new Setting(containerEl)
      .setName('Bridge enabled')
      .setDesc(
        'When ON: Obsidian shortcuts are patched so the bridge activates on every Obsidian launch. ' +
        'When OFF: shortcuts are restored to their original state and the bridge stops working after your next normal launch.'
      )
      .addToggle((t) => t
        .setValue(this.plugin.data.enabled === true)
        .onChange(async (v) => {
          await this.plugin.setEnabled(v);
          this.display();
        }));

    // Plain-language explainer
    const explainer = containerEl.createEl('div');
    explainer.style.cssText = 'padding:12px;background:var(--background-secondary);border-radius:6px;margin:8px 0 16px;font-size:13px;line-height:1.5;';
    explainer.createEl('p', {
      text: 'This plugin lets external AI tools (like Claude) drive Obsidian\'s built-in Web viewer as a browser. Useful for AI-assisted research, automated browsing, or letting an agent see what\'s on a webpage you\'re viewing.',
    });
    explainer.createEl('p', { text: 'How it works:' });
    const ol = explainer.createEl('ol');
    ol.createEl('li', { text: 'When you toggle "Bridge enabled" ON, this plugin adds a launch flag to your Obsidian shortcuts (Desktop, Start Menu, Taskbar pin). Original arguments are saved so the toggle can revert them.' });
    ol.createEl('li', { text: 'Next time you launch Obsidian normally, the bridge becomes active automatically. No special action needed.' });
    ol.createEl('li', { text: 'AI tools can then connect to the local debug port and drive the Web viewer (open URLs, click, screenshot, etc.).' });
    ol.createEl('li', { text: 'When you toggle the bridge OFF, the shortcuts are restored. The currently running Obsidian still has the bridge active until you close it; the next launch will be back to normal.' });

    // ── Status section ──
    const list = this.plugin.data.patchedShortcuts || [];
    new Setting(containerEl)
      .setName('Current state')
      .setDesc(
        this.plugin.data.enabled === false
          ? 'Bridge is disabled. Toggle "Bridge enabled" above to turn it back on.'
          : list.length > 0
          ? `${list.length} shortcut(s) currently patched. Bridge is active when Obsidian was launched via any of these.`
          : 'No shortcuts patched yet. The toggle will patch them on first activation.'
      );

    if (list.length > 0) {
      const details = containerEl.createEl('details');
      details.createEl('summary', { text: 'Show patched shortcuts' });
      const ul = details.createEl('ul');
      ul.style.cssText = 'font-size:12px;padding-left:20px;';
      for (const s of list) ul.createEl('li', { text: s.path });
    }

    // ── Advanced section ──
    containerEl.createEl('h3', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Debug port')
      .setDesc('Port that Obsidian listens on for CDP connections. Default 9222. Change only if it conflicts with another tool.')
      .addText((t) => t
        .setPlaceholder('9222')
        .setValue(String(this.plugin.data.port))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n > 1024 && n < 65536) {
            this.plugin.data.port = n;
            await this.plugin.saveData(this.plugin.data);
          }
        }));

    new Setting(containerEl)
      .setName('Restart Obsidian to apply bridge now')
      .setDesc('Optional. Quits and relaunches Obsidian via a patched shortcut so the bridge activates immediately. Same effect as closing and reopening Obsidian normally — just faster.')
      .addButton((b) => b.setButtonText('Restart now').setCta().onClick(() => this.plugin.restartObsidian()));

    new Setting(containerEl)
      .setName('Re-scan shortcuts')
      .setDesc('Forces a fresh scan of your Obsidian shortcuts. Useful if you added new shortcuts after enabling the bridge.')
      .addButton((b) => b.setButtonText('Scan + patch').onClick(async () => {
        const r = await this.plugin.patchShortcuts();
        new Notice(`Scanned. ${r.length} new shortcut(s) patched.`);
        this.display();
      }));
  }
}
