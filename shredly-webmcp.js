/**
 * shredly-webmcp.js
 *
 * Bridges Shredly hosted MCP servers to the browser's WebMCP API
 * (document.modelContext). Fetches tool definitions from Shredly and
 * registers them with the browser's native WebMCP implementation so any
 * in-page AI agent (ChatGPT, Codex, etc.) can discover and invoke them
 * — no redeploy needed when tools change in Shredly.
 *
 * Usage (ES module):
 *   import { ShrEdlyWebMCP } from './shredly-webmcp.js'
 *   ShrEdlyWebMCP.init({ slug: 'my-api' })
 *
 * Usage with per-user auth (token injected at call time, not init time):
 *   ShrEdlyWebMCP.init({
 *     slug: 'my-api',
 *     getToken: () => localStorage.getItem('user_token'),
 *   })
 *
 * Usage via <script> tag (exposes window.ShrEdlyWebMCP):
 *   <script src="shredly-webmcp.js"></script>
 *   <script>ShrEdlyWebMCP.init({ slug: 'my-api', getToken: () => ... })</script>
 */

const DEFAULT_BASE_URL = 'https://mcp.shredly.io';
const DEFAULT_POLL_INTERVAL = 30_000;

class ShrEdlyWebMCPBridge {
  constructor() {
    this._config = null;
    this._registered = new Map(); // internal registry for UI / getTools()
    this._pollTimer = null;
    this._lastSync = null;
    this._onSync = null;
    this._pendingRegistrations = []; // tools queued before document.modelContext was ready
    this._watchingForModelContext = false;
  }

  /**
   * Initialize the bridge. Fetches tool definitions immediately (no auth
   * required for tools/list) then polls for changes.
   *
   * @param {object}           opts
   * @param {string}           opts.slug           - Shredly MCP slug
   * @param {function|string} [opts.getToken]      - Returns the user's Bearer token at call
   *                                                 time. Can be sync or async. Omit for MCPs
   *                                                 that don't require user auth on tool calls.
   * @param {string}          [opts.baseUrl]       - Override Shredly base URL
   * @param {number}          [opts.pollInterval]  - Poll interval ms (default 30s, 0 = off)
   * @param {function}        [opts.onSync]        - Called after each sync: ({ tools, added, lastSync })
   */
  async init({ slug, getToken, baseUrl = DEFAULT_BASE_URL, pollInterval = DEFAULT_POLL_INTERVAL, onSync } = {}) {
    if (!slug) throw new Error('ShrEdlyWebMCP.init requires a slug');

    this._config = { slug, getToken: getToken ?? null, baseUrl, pollInterval };
    this._onSync = onSync ?? null;

    await this._sync();

    if (pollInterval > 0) {
      this._pollTimer = setInterval(() => this._sync().catch(console.error), pollInterval);
    }
  }

  /** Stop polling. */
  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Re-initialise with new config (e.g. user changes slug). */
  async reconnect(opts) {
    this.stop();
    this._registered.clear();
    await this.init(opts);
  }

  /**
   * Register tools from a hardcoded Shredly MCP record — no network fetch needed.
   * Useful for testing WebMCP registration in isolation, or for embedding tool
   * definitions statically so they register synchronously on page load.
   *
   * @param {object} mcpRecord - A Shredly MCP record (the shape returned by the API)
   * @param {object} [opts]
   * @param {function|string} [opts.getToken] - Same as init()'s getToken
   * @param {string}          [opts.baseUrl]  - Override Shredly base URL
   */
  initStatic(mcpRecord, { getToken, baseUrl = DEFAULT_BASE_URL, onSync } = {}) {
    if (!mcpRecord?.slug) throw new Error('initStatic requires an MCP record with a slug');

    this._config = { slug: mcpRecord.slug, getToken: getToken ?? null, baseUrl, pollInterval: 0 };
    this._onSync = onSync ?? null;

    const tools = (mcpRecord.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: this._buildInputSchema(t.input_schema ?? {}),
    }));

    for (const tool of tools) {
      if (!this._registered.has(tool.name)) {
        this._registered.set(tool.name, tool);
        this._registerWithBrowser(tool);
      }
    }

    this._lastSync = new Date();
    this._dispatchChange();
    this._onSync?.({ tools: this.getTools(), added: tools, lastSync: this._lastSync });
  }

  /**
   * Force a re-sync. Call this right after login so the token is available
   * for subsequent tool calls without waiting for the next poll.
   */
  async refresh() {
    return this._sync();
  }

  _buildInputSchema(input_schema) {
    const required = [];
    const properties = {};
    for (const [key, value] of Object.entries(input_schema)) {
      const isOptional = typeof value === 'object' && value !== null && value.optional === true;
      const { optional, ...rest } = typeof value === 'object' && value !== null ? value : { type: value };
      properties[key] = rest;
      if (!isOptional) required.push(key);
    }
    return { type: 'object', properties, required };
  }

  /** Return currently registered tools (from internal registry). */
  getTools() {
    return Array.from(this._registered.values());
  }

  /**
   * Directly execute a tool by name. The user's token is resolved at call
   * time via getToken(), so it always reflects the current auth state.
   */
  async executeTool(name, args = {}, context) {
    const { slug, baseUrl } = this._config;
    const token = await this._resolveToken();
    // WebMCP passes execution context, not necessarily an AbortSignal directly.
    // Only hand fetch a real signal from that context.
    const signal = context instanceof AbortSignal ? context : context?.signal;

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}/mcp/${slug}`, {
      method: 'POST',
      headers,
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id: Date.now(),
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message ?? 'MCP error');
    return data.result;
  }

  // --- private ---

  async _sync() {
    const { slug, baseUrl } = this._config;

    // tools/list requires no auth — registers on page load so the browser's
    // WebMCP scanner can discover tools before any user interaction.
    const res = await fetch(`${baseUrl}/mcp/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    });

    if (!res.ok) throw new Error(`Shredly responded ${res.status}`);

    const data = await res.json();
    if (data.error) throw new Error(data.error.message ?? 'MCP error');

    const tools = data.result?.tools ?? [];
    const added = [];

    for (const tool of tools) {
      if (!this._registered.has(tool.name)) {
        this._registered.set(tool.name, tool);
        this._registerWithBrowser(tool);
        added.push(tool);
      }
    }

    this._lastSync = new Date();
    if (added.length > 0) this._dispatchChange();
    this._onSync?.({ tools: this.getTools(), added, lastSync: this._lastSync });

    return { tools, added };
  }

  _registerWithBrowser(tool) {
    if (typeof document === 'undefined') return;

    if (typeof document.modelContext?.registerTool === 'function') {
      // Native WebMCP API is ready — register immediately.
      document.modelContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        execute: (params, context) => this.executeTool(tool.name, params, context),
      });
    } else {
      // Native API not ready yet (common: it initializes asynchronously after the
      // page's scripts run). Queue the tool and start watching for the API to appear.
      this._pendingRegistrations.push(tool);
      if (!this._watchingForModelContext) {
        this._watchingForModelContext = true;
        this._pollForModelContext();
      }
    }
  }

  _pollForModelContext() {
    const attempt = () => {
      if (typeof document.modelContext?.registerTool !== 'function') {
        setTimeout(attempt, 100);
        return;
      }
      // Native API is now available — flush all pending registrations.
      const pending = this._pendingRegistrations.splice(0);
      for (const tool of pending) {
        document.modelContext.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
          execute: (params, context) => this.executeTool(tool.name, params, context),
        });
      }
      this._watchingForModelContext = false;
    };
    setTimeout(attempt, 100);
  }

  _dispatchChange() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('shredly:toolchange', { detail: { tools: this.getTools() } })
    );
  }

  async _resolveToken() {
    const { getToken } = this._config;
    if (!getToken) return null;
    return typeof getToken === 'function' ? await getToken() : getToken;
  }
}

const ShrEdlyWebMCP = new ShrEdlyWebMCPBridge();

export { ShrEdlyWebMCP };

if (typeof window !== 'undefined') {
  window.ShrEdlyWebMCP = ShrEdlyWebMCP;
}
