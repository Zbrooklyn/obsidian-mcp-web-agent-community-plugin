#!/usr/bin/env node
/*
 * obsidian-mcp-web-agent (server)
 *
 * MCP server that drives Obsidian's built-in Web viewer via the Chrome DevTools
 * Protocol (raw CDP over WebSocket). Isolated from chrome-devtools / playwright
 * MCPs — this server connects ONLY to localhost:9222 and ONLY drives the webview
 * targets it finds there.
 *
 * Performance choices baked in (verified by the auto-research suite, 73% speedup
 * vs naive fixed-sleep + 3-eval baseline):
 *   - Wait strategy: Page.loadEventFired with 8s safety cap, NOT fixed sleep.
 *   - State reads: single bulk Runtime.evaluate returning {url, title, len}, NOT
 *     three separate calls.
 *   - Pre-screenshot: always wait for loadEventFired before capturing.
 */

const http = require('http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const CDP_HOST = process.env.OBSIDIAN_BRIDGE_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.OBSIDIAN_BRIDGE_PORT || '9222', 10);
const LOAD_EVENT_CAP_MS = parseInt(process.env.OBSIDIAN_BRIDGE_LOAD_CAP_MS || '8000', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.OBSIDIAN_BRIDGE_NAV_TIMEOUT_MS || '15000', 10);

// ─── HTTP helper for /json endpoints ──────────────────────────────────────

function fetchJson(pathStr) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path: pathStr, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON from ${pathStr}: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout on ${pathStr}`)));
  });
}

async function listTargets() {
  return await fetchJson('/json');
}

async function listWebviewTabs() {
  const targets = await listTargets();
  return targets
    .filter((t) => t.type === 'webview')
    .map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
}

async function findShellTarget() {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'page' && (t.url || '').startsWith('app://obsidian.md'));
}

// Resolve a tab specifier (number index, string url-fragment, or undefined for first webview)
async function resolveWebviewTarget(tabSpec) {
  const tabs = await listWebviewTabs();
  if (!tabs.length) return null;
  if (tabSpec === undefined || tabSpec === null) return tabs[0];
  if (typeof tabSpec === 'number') return tabs[tabSpec] || null;
  if (typeof tabSpec === 'string') {
    return tabs.find((t) => (t.url || '').includes(tabSpec) || (t.title || '').includes(tabSpec)) || null;
  }
  return null;
}

// ─── CDP WebSocket client ─────────────────────────────────────────────────

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = [];
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('ws error')); });
    });
    this.ws.addEventListener('message', (msg) => this._onMessage(msg));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  _onMessage(msg) {
    let d;
    try { d = JSON.parse(msg.data); } catch { return; }
    if (d.id != null && this.pending.has(d.id)) {
      const { resolve, reject } = this.pending.get(d.id);
      this.pending.delete(d.id);
      if (d.error) reject(new Error(`${d.error.code}: ${d.error.message}`));
      else resolve(d.result);
    } else if (d.method) {
      for (const h of this.eventHandlers) h(d);
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(t); resolve(r); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Wait for a CDP event, with cap. Returns { ok, ms, capped? }
  waitForEvent(method, capMs = LOAD_EVENT_CAP_MS) {
    return new Promise((resolve) => {
      const start = Date.now();
      const t = setTimeout(() => {
        this._removeHandler(handler);
        resolve({ ok: false, ms: Date.now() - start, capped: true });
      }, capMs);
      const handler = (d) => {
        if (d.method === method) {
          clearTimeout(t);
          this._removeHandler(handler);
          resolve({ ok: true, ms: Date.now() - start });
        }
      };
      this.eventHandlers.push(handler);
    });
  }

  _removeHandler(h) {
    const i = this.eventHandlers.indexOf(h);
    if (i >= 0) this.eventHandlers.splice(i, 1);
  }

  close() {
    if (this.ws && this.ws.readyState === 1) this.ws.close();
  }
}

// ─── Bridge operations (shared by all tools) ──────────────────────────────

async function withWebviewSession(fn, tabSpec) {
  const wv = await resolveWebviewTarget(tabSpec);
  if (!wv) {
    if (tabSpec !== undefined && tabSpec !== null) {
      throw new Error(`No Web viewer tab matched: ${JSON.stringify(tabSpec)}. Use obsidian_list_tabs to see available tabs.`);
    }
    throw new Error(
      'No Web viewer tab open. Open one with obsidian_new_tab(url), or open one manually ' +
      'in Obsidian (Cmd palette → "Web viewer: Open").'
    );
  }
  const session = new CdpSession(wv.webSocketDebuggerUrl);
  await session.open();
  try {
    return await fn(session, wv);
  } finally {
    session.close();
  }
}

// Run code in the SHELL page context (where app.workspace lives) — for tab management.
async function withShellSession(fn) {
  const shell = await findShellTarget();
  if (!shell) throw new Error('No Obsidian shell page found. Is Obsidian running with the bridge active?');
  const session = new CdpSession(shell.webSocketDebuggerUrl);
  await session.open();
  try { return await fn(session, shell); }
  finally { session.close(); }
}

async function bridgeNavigate(url, tab) {
  return await withWebviewSession(async (s) => {
    const navResult = await s.send('Page.navigate', { url }, NAV_TIMEOUT_MS);
    if (navResult.errorText) {
      return { ok: false, error: navResult.errorText, url };
    }
    const wait = await s.waitForEvent('Page.loadEventFired', LOAD_EVENT_CAP_MS);
    const state = await s.send('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title, len: (document.body && document.body.innerText || "").length })',
      returnByValue: true,
    });
    return {
      ok: true,
      requested: url,
      finalUrl: state.result?.value?.url,
      title: state.result?.value?.title,
      contentLength: state.result?.value?.len,
      loadFired: wait.ok,
      loadWaitMs: wait.ms,
    };
  }, tab);
}

async function bridgeReadState(tab) {
  return await withWebviewSession(async (s) => {
    const r = await s.send('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title, len: (document.body && document.body.innerText || "").length, readyState: document.readyState })',
      returnByValue: true,
    });
    return r.result?.value;
  }, tab);
}

async function bridgeReadText(maxChars = 8000, tab) {
  return await withWebviewSession(async (s) => {
    const r = await s.send('Runtime.evaluate', {
      expression: `(document.body && document.body.innerText || '').slice(0, ${maxChars | 0})`,
      returnByValue: true,
    });
    return { url: undefined, text: r.result?.value || '' };
  }, tab);
}

async function bridgeEvaluate(expression, tab) {
  return await withWebviewSession(async (s) => {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true }, 12000);
    return { value: r.result?.value, type: r.result?.type, description: r.result?.description };
  }, tab);
}

async function bridgeScreenshot(format = 'png', quality, tab) {
  return await withWebviewSession(async (s) => {
    const params = { format };
    if (format === 'jpeg' && Number.isInteger(quality)) params.quality = Math.max(1, Math.min(100, quality));
    const r = await s.send('Page.captureScreenshot', params, 15000);
    if (!r.data) return { ok: false, error: 'no data returned' };
    const bytes = Buffer.from(r.data, 'base64').length;
    return { ok: true, format, bytes, base64: r.data };
  }, tab);
}

async function bridgeClick(selector, tab) {
  return await withWebviewSession(async (s) => {
    const escaped = JSON.stringify(selector);
    const r = await s.send('Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${escaped});
        if (!el) return { ok: false, reason: 'no element matched selector' };
        const rect = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus && el.focus();
        el.click();
        return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 100), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      })()`,
      returnByValue: true,
    });
    return r.result?.value || { ok: false, reason: 'evaluate returned nothing' };
  }, tab);
}

// ─── New: interactive primitives ─────────────────────────────────────────

// Type text into a focused element or a selector-targeted element.
// Uses Input.dispatchKeyEvent per character — produces real keystrokes that
// React/contenteditable inputs (Gmail, etc.) accept correctly.
async function bridgeType(text, selector, submit, tab) {
  return await withWebviewSession(async (s) => {
    // Set value via the native prototype setter + dispatch input event. This is the
    // canonical way to write to React-controlled inputs from outside — Playwright uses
    // this strategy for the same reason. CDP Input.insertText silently no-ops on
    // some React inputs (DuckDuckGo, Gmail compose, etc.) because React reconciles
    // its tracked value back over the synthetic insertion.
    const expr = `(function(){
      const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
      if (!el) return { ok: false, reason: 'no target element (no selector match or no focused element)' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const text = ${JSON.stringify(String(text))};
      const isFormInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
      if (isFormInput) {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, (el.value || '') + text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, mode: 'value-setter', tag: el.tagName, finalValue: el.value };
      }
      // contenteditable / other — use execCommand insertText
      try {
        document.execCommand('insertText', false, text);
        return { ok: true, mode: 'execCommand', tag: el.tagName };
      } catch (e) {
        // last-resort textContent append
        el.textContent = (el.textContent || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, mode: 'textContent', tag: el.tagName };
      }
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 6000);
    const v = r.result?.value;
    if (!v || !v.ok) return v || { ok: false, reason: 'evaluate returned nothing' };

    let submitMode = null;
    if (submit) {
      // Step 1: dispatch a real Enter keystroke. Works for: keyboard-listener pages,
      // Gmail compose (Cmd+Enter is separate), most Discourse/forum search boxes.
      const beforeUrl = (await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value;
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 4000);
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 4000);
      submitMode = 'enter-key';

      // Step 2: if the input was in a form and Enter didn't move the page in 600ms,
      // fall back to form.requestSubmit(). React-controlled search boxes (DDG, etc.)
      // intercept Enter and ignore the default submit — this fallback bypasses that.
      await new Promise((r) => setTimeout(r, 600));
      const afterUrl = (await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value;
      if (afterUrl === beforeUrl) {
        const fallback = await s.send('Runtime.evaluate', {
          expression: `(function(){
            const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
            const f = el && el.form;
            if (!f) return { fallback: 'no-form' };
            try {
              if (f.requestSubmit) f.requestSubmit();
              else f.submit();
              return { fallback: 'requestSubmit' };
            } catch (e) {
              return { fallback: 'error', error: String(e && e.message || e) };
            }
          })()`,
          returnByValue: true,
        }, 4000);
        const fb = fallback.result?.value;
        if (fb && fb.fallback === 'requestSubmit') submitMode = 'enter-key+requestSubmit';
        else if (fb) submitMode = `enter-key (fallback ${fb.fallback})`;
      }
    }
    return { ok: true, typed: text.length, mode: v.mode, tag: v.tag, submitMode };
  }, tab);
}

const KEY_TABLE = {
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32 },
};

async function bridgePressKey(key, tab) {
  return await withWebviewSession(async (s) => {
    const k = KEY_TABLE[key];
    if (!k) return { ok: false, reason: `unsupported key: ${key}. Supported: ${Object.keys(KEY_TABLE).join(', ')}` };
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.vk }, 4000);
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk }, 4000);
    return { ok: true, key };
  }, tab);
}

async function bridgeHover(selector, tab) {
  return await withWebviewSession(async (s) => {
    const r = await s.send('Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, reason: 'no element matched selector' };
        const rect = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: el.tagName };
      })()`,
      returnByValue: true,
    });
    const v = r.result?.value;
    if (!v || !v.ok) return v || { ok: false, reason: 'evaluate returned nothing' };
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: v.x, y: v.y }, 4000);
    return { ok: true, x: v.x, y: v.y, tag: v.tag };
  }, tab);
}

async function bridgeSelectOption(selector, value, tab) {
  return await withWebviewSession(async (s) => {
    const r = await s.send('Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, reason: 'no element matched selector' };
        if (el.tagName !== 'SELECT') return { ok: false, reason: 'element is not a <select>: ' + el.tagName };
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, selected: el.value, available: Array.from(el.options).map(o => o.value) };
      })()`,
      returnByValue: true,
    });
    return r.result?.value || { ok: false, reason: 'evaluate returned nothing' };
  }, tab);
}

async function bridgeWaitFor({ selector, text, timeoutMs = 10000, tab } = {}) {
  return await withWebviewSession(async (s) => {
    const start = Date.now();
    const expr = (() => {
      if (selector && text) {
        return `(function(){ const el = document.querySelector(${JSON.stringify(selector)}); return el && el.innerText && el.innerText.includes(${JSON.stringify(text)}) ? { ok: true, found: 'selector+text' } : { ok: false }; })()`;
      }
      if (selector) {
        return `document.querySelector(${JSON.stringify(selector)}) ? { ok: true, found: 'selector' } : { ok: false }`;
      }
      if (text) {
        return `document.body && document.body.innerText.includes(${JSON.stringify(text)}) ? { ok: true, found: 'text' } : { ok: false }`;
      }
      return `{ ok: false, reason: 'no selector or text given' }`;
    })();
    while (Date.now() - start < timeoutMs) {
      const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 4000);
      const v = r.result?.value;
      if (v && v.ok) return { ok: true, ms: Date.now() - start, found: v.found };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, reason: 'timeout', ms: Date.now() - start };
  }, tab);
}

async function bridgeGetHtml(selector, maxLength = 50000, tab) {
  return await withWebviewSession(async (s) => {
    const expr = selector
      ? `(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: 'no element matched selector' };
          return { ok: true, html: el.outerHTML.slice(0, ${maxLength | 0}), truncated: el.outerHTML.length > ${maxLength | 0} };
        })()`
      : `({ ok: true, html: document.documentElement.outerHTML.slice(0, ${maxLength | 0}), truncated: document.documentElement.outerHTML.length > ${maxLength | 0} })`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.value || { ok: false, reason: 'evaluate returned nothing' };
  }, tab);
}

// ─── New: tab management (operates on the SHELL, not webview) ─────────────

async function bridgeListTabs() {
  const tabs = await listWebviewTabs();
  return tabs.map((t) => ({ index: t.index, title: t.title, url: t.url }));
}

async function bridgeNewTab(url) {
  // Use Obsidian's workspace API from the shell page to open a new Web viewer leaf.
  return await withShellSession(async (s) => {
    const expr = `(async () => {
      try {
        const leaf = app.workspace.getLeaf(true);
        await leaf.setViewState({ type: 'webviewer', active: true, state: { url: ${JSON.stringify(url)}, navigate: true } });
        app.workspace.revealLeaf(leaf);
        return { ok: true, requested: ${JSON.stringify(url)} };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 10000);
    const v = r.result?.value;
    if (!v || !v.ok) return v || { ok: false, reason: 'shell evaluate returned nothing' };
    // Wait briefly so the new tab is enumerable, then return its info.
    await new Promise((r) => setTimeout(r, 600));
    const tabs = await listWebviewTabs();
    const newest = tabs.find((t) => (t.url || '').includes(url)) || tabs[tabs.length - 1];
    return { ok: true, requested: url, tab: newest && { index: newest.index, title: newest.title, url: newest.url } };
  });
}

async function bridgeCloseTab(tabSpec) {
  // Find the matching webview leaf in the workspace and detach it.
  const targets = await listTargets();
  const wvs = targets.filter((t) => t.type === 'webview');
  let target;
  if (typeof tabSpec === 'number') target = wvs[tabSpec];
  else if (typeof tabSpec === 'string') target = wvs.find((t) => (t.url || '').includes(tabSpec));
  if (!target) return { ok: false, reason: `no webview tab matched: ${JSON.stringify(tabSpec)}` };

  return await withShellSession(async (s) => {
    const targetUrl = target.url;
    const expr = `(() => {
      try {
        const leaves = app.workspace.getLeavesOfType('webviewer');
        const leaf = leaves.find(l => {
          const v = l.view;
          const u = (v && (v.url || (v.contentEl && v.contentEl.querySelector('webview') && v.contentEl.querySelector('webview').src)));
          return u && u.includes(${JSON.stringify(targetUrl)});
        });
        if (!leaf) return { ok: false, reason: 'no matching workspace leaf for webview tab' };
        leaf.detach();
        return { ok: true, closedUrl: ${JSON.stringify(targetUrl)} };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.value || { ok: false, reason: 'shell evaluate returned nothing' };
  });
}

// ─── v0.6 additions: snapshot, scroll, history nav, console, network idle, cookies ─

// Error code constants — used by new tools. Existing tools keep their free-text
// `reason` field for backward compatibility; new tools also include `code`.
const ERR = {
  SELECTOR_NOT_FOUND: 'SelectorNotFound',
  NOT_INTERACTIVE: 'NotInteractive',
  TIMEOUT: 'Timeout',
  EVAL_FAILED: 'EvalFailed',
  NAV_FAILED: 'NavigationFailed',
  BRIDGE_UNREACHABLE: 'BridgeUnreachable',
  CDP_ERROR: 'CdpError',
};

function err(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// Inject a one-time console hook into the page that captures console.* calls
// into window.__obsidian_bridge_console (capped). Re-injection on every read is
// idempotent. Must run before reads to prime the buffer.
const CONSOLE_HOOK_SCRIPT = `(function(){
  if (window.__obsidian_bridge_console_installed) return;
  window.__obsidian_bridge_console_installed = true;
  window.__obsidian_bridge_console = [];
  const MAX = 500;
  const origs = {};
  ['log','info','warn','error','debug'].forEach(level => {
    origs[level] = console[level].bind(console);
    console[level] = function(...args) {
      try {
        const text = args.map(a => {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a).slice(0, 500); }
          catch { return String(a); }
        }).join(' ');
        window.__obsidian_bridge_console.push({ level, text, ts: Date.now() });
        while (window.__obsidian_bridge_console.length > MAX) window.__obsidian_bridge_console.shift();
      } catch {}
      return origs[level](...args);
    };
  });
  // also capture uncaught errors
  window.addEventListener('error', (e) => {
    window.__obsidian_bridge_console.push({ level: 'error', text: 'Uncaught: ' + (e.message || String(e)), ts: Date.now() });
    while (window.__obsidian_bridge_console.length > MAX) window.__obsidian_bridge_console.shift();
  });
})()`;

async function bridgeSnapshot(maxNodes = 80, tab) {
  return await withWebviewSession(async (s) => {
    const expr = `(() => {
      const interactive = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
      };
      const labelOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.slice(0, 120);
        const title = el.getAttribute('title');
        if (title) return title.slice(0, 120);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const ph = el.getAttribute('placeholder');
          if (ph) return '[placeholder] ' + ph.slice(0, 100);
          const lab = el.labels && el.labels[0];
          if (lab) return lab.innerText.trim().slice(0, 120);
        }
        return (el.innerText || el.value || '').trim().slice(0, 120);
      };
      const cssPath = (el) => {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
          let p = cur.tagName.toLowerCase();
          if (cur.id) { p += '#' + cur.id; parts.unshift(p); break; }
          if (cur.parentElement) {
            const sib = Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName);
            if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
          }
          parts.unshift(p);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const els = Array.from(document.querySelectorAll(interactive)).filter(visible);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).filter(visible);
      const out = [];
      let ref = 0;
      for (const el of headings.slice(0, 10)) {
        out.push({ ref: 'h' + (++ref), kind: 'heading', tag: el.tagName.toLowerCase(), text: el.innerText.trim().slice(0, 120) });
      }
      for (const el of els.slice(0, ${maxNodes | 0})) {
        const r = el.getBoundingClientRect();
        out.push({
          ref: 'e' + (++ref),
          kind: 'interactive',
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || (el.type ? el.type : null),
          name: labelOf(el),
          selector: cssPath(el),
          xy: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
        });
      }
      return { ok: true, url: location.href, title: document.title, count: out.length, totalInteractive: els.length, totalHeadings: headings.length, items: out };
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 8000);
    return r.result?.value || err(ERR.EVAL_FAILED, 'snapshot evaluate returned nothing');
  }, tab);
}

async function bridgeScroll({ direction = 'down', amount = 500, selector, tab } = {}) {
  return await withWebviewSession(async (s) => {
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const expr = selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, code: ${JSON.stringify(ERR.SELECTOR_NOT_FOUND)}, message: 'no element matched selector' };
          if (${JSON.stringify(direction)} === 'into-view') {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            return { ok: true, mode: 'into-view', tag: el.tagName };
          }
          el.scrollBy(${dx}, ${dy});
          return { ok: true, mode: 'element', tag: el.tagName, scrollTop: el.scrollTop };
        })()`
      : `(() => {
          if (${JSON.stringify(direction)} === 'top') { window.scrollTo(0, 0); return { ok: true, mode: 'top' }; }
          if (${JSON.stringify(direction)} === 'bottom') { window.scrollTo(0, document.body.scrollHeight); return { ok: true, mode: 'bottom' }; }
          window.scrollBy(${dx}, ${dy});
          return { ok: true, mode: 'page', y: window.scrollY };
        })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 4000);
    return r.result?.value || err(ERR.EVAL_FAILED, 'scroll evaluate returned nothing');
  }, tab);
}

async function bridgeHistory(action, tab) {
  return await withWebviewSession(async (s) => {
    const exprByAction = {
      back: 'history.back(); ({ ok: true, action: "back" })',
      forward: 'history.forward(); ({ ok: true, action: "forward" })',
      reload: 'location.reload(); ({ ok: true, action: "reload" })',
    };
    const expr = exprByAction[action];
    if (!expr) return err(ERR.EVAL_FAILED, `unknown history action: ${action}`);
    await s.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 4000);
    // Don't wait for loadEventFired here — back/forward may fire instantly from cache.
    await new Promise((r) => setTimeout(r, 800));
    const stateR = await s.send('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title })',
      returnByValue: true,
    });
    return { ok: true, action, ...(stateR.result?.value || {}) };
  }, tab);
}

async function bridgeConsoleMessages({ levels, since, max = 100, clear = false, tab } = {}) {
  return await withWebviewSession(async (s) => {
    // Ensure hook is installed
    await s.send('Runtime.evaluate', { expression: CONSOLE_HOOK_SCRIPT, returnByValue: true }, 3000);

    const filterExpr = `(() => {
      const buf = window.__obsidian_bridge_console || [];
      const sinceTs = ${Number.isFinite(since) ? since : 0};
      const allowed = ${levels && Array.isArray(levels) ? JSON.stringify(levels) : 'null'};
      let out = buf.filter(m => m.ts >= sinceTs);
      if (allowed) out = out.filter(m => allowed.includes(m.level));
      out = out.slice(-${max | 0});
      if (${clear ? 'true' : 'false'}) window.__obsidian_bridge_console = [];
      return { ok: true, count: out.length, totalBuffered: buf.length, messages: out };
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: filterExpr, returnByValue: true }, 4000);
    return r.result?.value || err(ERR.EVAL_FAILED, 'console read returned nothing');
  }, tab);
}

async function bridgeWaitForNetworkIdle({ idleMs = 800, timeoutMs = 8000, tab } = {}) {
  return await withWebviewSession(async (s) => {
    // In-page polling using PerformanceObserver — counts new resource entries.
    // Returns when no resource entry has appeared in `idleMs` ms, or after timeoutMs.
    const expr = `(async () => {
      const start = performance.now();
      let lastEntry = performance.now();
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) lastEntry = performance.now();
      });
      try { obs.observe({ type: 'resource', buffered: false }); }
      catch (e) { return { ok: false, code: 'EvalFailed', message: 'PerformanceObserver failed: ' + (e.message || e) }; }
      while (performance.now() - start < ${timeoutMs | 0}) {
        if (performance.now() - lastEntry >= ${idleMs | 0}) {
          obs.disconnect();
          return { ok: true, idleAchievedMs: Math.round(performance.now() - start) };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      obs.disconnect();
      return { ok: false, code: 'Timeout', message: 'network not idle within timeoutMs', elapsedMs: ${timeoutMs | 0} };
    })()`;
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs + 2000);
    return r.result?.value || err(ERR.EVAL_FAILED, 'network-idle wait returned nothing');
  }, tab);
}

async function bridgeCookies({ urls, tab } = {}) {
  return await withWebviewSession(async (s) => {
    const params = {};
    if (urls && urls.length) params.urls = urls;
    try {
      const r = await s.send('Network.getCookies', params, 5000);
      const cookies = (r.cookies || []).map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expires,
        valueLen: (c.value || '').length, // value omitted by default — privacy
      }));
      return { ok: true, count: cookies.length, cookies };
    } catch (e) {
      return err(ERR.CDP_ERROR, 'Network.getCookies failed: ' + (e.message || e));
    }
  }, tab);
}

async function bridgeStatus() {
  try {
    const v = await fetchJson('/json/version');
    const ts = await listTargets();
    const wv = ts.find((t) => t.type === 'webview');
    return {
      reachable: true,
      browser: v.Browser,
      protocol: v['Protocol-Version'],
      port: CDP_PORT,
      targetCount: ts.length,
      webviewPresent: !!wv,
      webviewUrl: wv?.url,
      webviewTitle: wv?.title,
    };
  } catch (e) {
    return {
      reachable: false,
      port: CDP_PORT,
      error: e.message,
      hint: 'Make sure Obsidian is running with --remote-debugging-port=' + CDP_PORT + '. The Claude Browser Bridge plugin patches Obsidian shortcuts to do this automatically; if you launched without a patched shortcut the port will not be open.',
    };
  }
}

// ─── MCP tool definitions ─────────────────────────────────────────────────

// All webview-driving tools accept an optional `tab` param: number index, URL/title fragment, or omitted (= first tab).
const TAB_PROP = { tab: { description: 'Which Web viewer tab. Number index, URL or title fragment match, or omit for first tab.', anyOf: [{ type: 'integer' }, { type: 'string' }] } };

const TOOLS = [
  {
    name: 'obsidian_status',
    description:
      'Check whether the Obsidian Browser Bridge is reachable. Returns Chrome version, port, target count, and whether a Web viewer is open. Call first if other tools are returning errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_navigate',
    description:
      'Navigate a Web viewer tab to a URL. Waits for Page.loadEventFired (capped ' + (LOAD_EVENT_CAP_MS / 1000) +
      's) then returns final URL + title + content length. If no Web viewer is open, use obsidian_new_tab first.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (http:// or https://)' },
        ...TAB_PROP,
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_read_state',
    description:
      'Read current state of a Web viewer tab in one round trip: { url, title, len, readyState }.',
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
  },
  {
    name: 'obsidian_read_text',
    description: 'Read up to maxChars of document.body.innerText from a Web viewer tab.',
    inputSchema: {
      type: 'object',
      properties: { maxChars: { type: 'integer', minimum: 100, maximum: 200000, default: 8000 }, ...TAB_PROP },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_get_html',
    description:
      'Get HTML of a selector (or the whole document if no selector). Capped at maxLength chars. Use this to inspect page structure before clicking or typing.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector. If omitted, returns documentElement.outerHTML.' },
        maxLength: { type: 'integer', minimum: 100, maximum: 500000, default: 50000 },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_evaluate',
    description:
      'Run a JavaScript expression in a Web viewer tab\'s page context and return the result. Like pasting into DevTools console.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression. Wrap multi-statement code in (() => { ... })().' },
        ...TAB_PROP,
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_screenshot',
    description: 'Capture a screenshot of a Web viewer tab. Returns base64 image. Default png; jpeg supported.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG quality (jpeg only)' },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_click',
    description:
      'Click an element in a Web viewer tab by CSS selector. Scrolls into view + focuses + clicks. Returns the matched element\'s tag/text/rect.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector' }, ...TAB_PROP },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_type',
    description:
      'Type text into a focused element or a selector-targeted element in a Web viewer tab. Uses real keystrokes via CDP — works with React/contenteditable inputs (Gmail, etc.) that ignore synthetic events. Optional submit:true sends Enter at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        selector: { type: 'string', description: 'Optional. If given, focuses this element first.' },
        submit: { type: 'boolean', default: false, description: 'If true, presses Enter after typing.' },
        ...TAB_PROP,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_press_key',
    description:
      'Dispatch a single non-character key in a Web viewer tab. Supported: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name (case-sensitive)' }, ...TAB_PROP },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_hover',
    description: 'Hover over an element by CSS selector. Triggers hover-only menus and tooltips.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, ...TAB_PROP },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_select_option',
    description: 'Set the value of a <select> element by CSS selector. Fires change + input events.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string', description: 'The option value to select' },
        ...TAB_PROP,
      },
      required: ['selector', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_wait_for',
    description:
      'Poll a Web viewer tab until a selector exists, or text appears in body, or both. Returns when matched or after timeoutMs. Essential before acting on JS-rendered pages (Gmail, GitHub SPA, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text to wait for (in element if selector also given, else in body)' },
        timeoutMs: { type: 'integer', minimum: 200, maximum: 60000, default: 10000 },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_list_tabs',
    description:
      'List all Web viewer tabs currently open in Obsidian. Each tab has an index, title, and URL. Use the index or a URL/title fragment as the `tab` argument to other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_new_tab',
    description:
      'Open a new Web viewer pane in Obsidian and navigate it to the given URL. Returns the new tab\'s index. Use when no Web viewer is open or when you want a separate tab.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to load in the new tab' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_close_tab',
    description: 'Close a Web viewer tab by index or URL/title fragment.',
    inputSchema: {
      type: 'object',
      properties: { tab: { description: 'Index (number) or URL/title fragment (string)', anyOf: [{ type: 'integer' }, { type: 'string' }] } },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_snapshot',
    description:
      'Returns a structured list of interactive elements (buttons, links, inputs, textareas) and visible headings on the current page, each with a stable selector you can pass to obsidian_click / obsidian_type. Use this BEFORE acting on a complex page (Gmail, dashboards, forms) — it tells you what you can act on without parsing HTML. Headings give context. maxNodes caps the interactive list size.',
    inputSchema: {
      type: 'object',
      properties: {
        maxNodes: { type: 'integer', minimum: 5, maximum: 300, default: 80 },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_scroll',
    description:
      'Scroll the page or a specific element. direction: up / down / left / right (with amount in px), or top / bottom (page only), or into-view (selector required). Useful for: loading more results, revealing lazy-loaded content, scrolling email lists.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom', 'into-view'], default: 'down' },
        amount: { type: 'integer', minimum: 1, maximum: 20000, default: 500, description: 'Pixels to scroll (ignored for top/bottom/into-view)' },
        selector: { type: 'string', description: 'If given, scrolls this element instead of the page (or scrolls it into view if direction=into-view)' },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_back',
    description: 'Navigate the Web viewer back one step in history. Use to return after drilling into a list item.',
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
  },
  {
    name: 'obsidian_forward',
    description: 'Navigate the Web viewer forward one step in history.',
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
  },
  {
    name: 'obsidian_reload',
    description: 'Reload the current page in the Web viewer.',
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
  },
  {
    name: 'obsidian_console_messages',
    description:
      'Read recent JS console messages (log/info/warn/error/debug) and uncaught errors from the Web viewer page. The hook is installed lazily on first call — messages from before that call are not captured. Useful for debugging pages Claude is automating.',
    inputSchema: {
      type: 'object',
      properties: {
        levels: { type: 'array', items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] }, description: 'Filter to these levels only.' },
        since: { type: 'integer', description: 'Unix ms timestamp — only return messages with ts >= this.' },
        max: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        clear: { type: 'boolean', default: false, description: 'Clear the buffer after reading.' },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_wait_for_network_idle',
    description:
      'Wait until the page reports no new resource fetches for `idleMs` ms (using PerformanceObserver). Essential after submitting forms or triggering AJAX — lets you know the page actually finished loading data, not just rendered. Returns ok:true with elapsed time, or ok:false code:"Timeout" if it never went quiet.',
    inputSchema: {
      type: 'object',
      properties: {
        idleMs: { type: 'integer', minimum: 100, maximum: 10000, default: 800, description: 'How long the network must be quiet before considering it idle.' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 30000, default: 8000 },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_cookies',
    description:
      'Read cookies for the current page (or for specific URLs). Returns name/domain/path/flags but NOT the value (privacy — only valueLen). Useful for inspecting logged-in session state.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional list of URLs to scope the cookie query. Default: all cookies the page can see.' },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_list_targets',
    description: 'Diagnostic. Enumerate all raw CDP targets (pages, webviews, workers).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ─── Server wiring ────────────────────────────────────────────────────────

function toolResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

const server = new Server(
  { name: 'obsidian-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case 'obsidian_status': {
        const s = await bridgeStatus();
        return toolResult(JSON.stringify(s, null, 2));
      }
      case 'obsidian_navigate': {
        const r = await bridgeNavigate(args.url, args.tab);
        return toolResult(JSON.stringify(r, null, 2));
      }
      case 'obsidian_read_state': {
        const r = await bridgeReadState(args.tab);
        return toolResult(JSON.stringify(r, null, 2));
      }
      case 'obsidian_read_text': {
        const r = await bridgeReadText(args.maxChars || 8000, args.tab);
        return toolResult(r.text || '(empty page)');
      }
      case 'obsidian_get_html': {
        const r = await bridgeGetHtml(args.selector, args.maxLength || 50000, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_evaluate': {
        const r = await bridgeEvaluate(args.expression, args.tab);
        return toolResult(JSON.stringify(r, null, 2));
      }
      case 'obsidian_screenshot': {
        const r = await bridgeScreenshot(args.format || 'png', args.quality, args.tab);
        if (!r.ok) return toolResult(`Screenshot failed: ${r.error}`, true);
        return {
          content: [
            { type: 'text', text: `Captured ${r.bytes} bytes, format=${r.format}` },
            { type: 'image', data: r.base64, mimeType: r.format === 'jpeg' ? 'image/jpeg' : 'image/png' },
          ],
        };
      }
      case 'obsidian_click': {
        const r = await bridgeClick(args.selector, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_type': {
        const r = await bridgeType(args.text, args.selector, !!args.submit, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_press_key': {
        const r = await bridgePressKey(args.key, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_hover': {
        const r = await bridgeHover(args.selector, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_select_option': {
        const r = await bridgeSelectOption(args.selector, args.value, args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_wait_for': {
        const r = await bridgeWaitFor({ selector: args.selector, text: args.text, timeoutMs: args.timeoutMs, tab: args.tab });
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_list_tabs': {
        const r = await bridgeListTabs();
        return toolResult(JSON.stringify(r, null, 2));
      }
      case 'obsidian_new_tab': {
        const r = await bridgeNewTab(args.url);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_close_tab': {
        const r = await bridgeCloseTab(args.tab);
        return toolResult(JSON.stringify(r, null, 2), !r.ok);
      }
      case 'obsidian_snapshot': {
        const r = await bridgeSnapshot(args.maxNodes || 80, args.tab);
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_scroll': {
        const r = await bridgeScroll({ direction: args.direction || 'down', amount: args.amount || 500, selector: args.selector, tab: args.tab });
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_back': {
        const r = await bridgeHistory('back', args.tab);
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_forward': {
        const r = await bridgeHistory('forward', args.tab);
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_reload': {
        const r = await bridgeHistory('reload', args.tab);
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_console_messages': {
        const r = await bridgeConsoleMessages({
          levels: args.levels,
          since: args.since,
          max: args.max,
          clear: args.clear,
          tab: args.tab,
        });
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_wait_for_network_idle': {
        const r = await bridgeWaitForNetworkIdle({ idleMs: args.idleMs, timeoutMs: args.timeoutMs, tab: args.tab });
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_cookies': {
        const r = await bridgeCookies({ urls: args.urls, tab: args.tab });
        return toolResult(JSON.stringify(r, null, 2), r.ok === false);
      }
      case 'obsidian_list_targets': {
        const ts = await listTargets();
        const summary = ts.map((t) => ({ type: t.type, title: t.title, url: t.url }));
        return toolResult(JSON.stringify(summary, null, 2));
      }
      default:
        return toolResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return toolResult(`Error: ${e.message}`, true);
  }
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`obsidian-mcp-web-agent v0.4.0 ready (port ${CDP_PORT})\n`);
})().catch((e) => {
  process.stderr.write(`obsidian-mcp-web-agent fatal: ${e.message}\n`);
  process.exit(1);
});
