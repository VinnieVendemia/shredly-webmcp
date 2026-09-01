# shredly-webmcp

Bridge [Shredly](https://shredly.io) hosted MCP servers to the browser's [WebMCP API](https://learn.chatgpt.com/docs/webmcp) (`document.modelContext`).

Add your Shredly MCP to any webpage and AI agents (ChatGPT, Codex) can discover and invoke your tools as native site tools — no redeploy needed when you add or update tools in your Shredly dashboard.

---

## How it works

1. You create an MCP server on [Shredly](https://shredly.io) and define your tools there
2. You add this library to your site with your MCP slug
3. On page load, the library fetches your tool definitions from Shredly and registers them via `document.modelContext.registerTool()`
4. AI agents browsing your site see your tools in the **Site tools** panel and can invoke them
5. Add a new tool in Shredly → it appears on your site within 30 seconds, no redeploy

---

## Installation

### CDN (recommended — zero build step)

```html
<script src="https://cdn.shredly.io/webmcp.js"></script>
<script>
  ShrEdlyWebMCP.init({ slug: 'your-mcp-slug' })
</script>
```

### npm

```bash
npm install shredly-webmcp
```

```js
import { ShrEdlyWebMCP } from 'shredly-webmcp'
ShrEdlyWebMCP.init({ slug: 'your-mcp-slug' })
```

---

## Usage

### Public MCP (no user auth)

```html
<script src="https://cdn.shredly.io/webmcp.js"></script>
<script>
  ShrEdlyWebMCP.init({ slug: 'your-mcp-slug' })
</script>
```

### With per-user authentication

If your tools require a user token (e.g. the user has logged into your site), pass a `getToken` function. It's called fresh on every tool invocation — so it always reflects the current session state, even if the user logs in after the page loads.

```html
<script src="https://cdn.shredly.io/webmcp.js"></script>
<script>
  ShrEdlyWebMCP.init({
    slug: 'your-mcp-slug',
    getToken: () => localStorage.getItem('user_token'),
  })
</script>
```

`getToken` can also be async, for token refresh flows:

```js
ShrEdlyWebMCP.init({
  slug: 'your-mcp-slug',
  getToken: async () => {
    const token = localStorage.getItem('token')
    return isExpired(token) ? await refreshToken() : token
  },
})
```

### After user logs in

Call `refresh()` to immediately re-sync tools with the new token, rather than waiting for the next 30-second poll:

```js
async function onLoginSuccess(token) {
  localStorage.setItem('user_token', token)
  await ShrEdlyWebMCP.refresh()
}
```

---

## API

### `ShrEdlyWebMCP.init(opts)`

Fetches tool definitions from Shredly, registers them with the browser's WebMCP API, and starts polling for changes.

| Option | Type | Default | Description |
|---|---|---|---|
| `slug` | `string` | required | Your Shredly MCP slug |
| `getToken` | `() => string \| Promise<string>` | — | Returns the user's Bearer token at call time. Omit for MCPs that don't require user auth. |
| `baseUrl` | `string` | `https://mcp.shredly.io` | Override the Shredly base URL |
| `pollInterval` | `number` | `30000` | How often to check for new tools (ms). Set to `0` to disable. |
| `onSync` | `({ tools, added, lastSync }) => void` | — | Called after each sync. Useful for updating UI. |

### `ShrEdlyWebMCP.reconnect(opts)`

Stop polling, clear registered tools, and re-initialize with new options. Use when the user changes their connected MCP or logs into a different account.

### `ShrEdlyWebMCP.refresh()`

Manually trigger a tool sync. Useful to call immediately after a user logs in so their token is available for the next tool call without waiting for the next poll.

### `ShrEdlyWebMCP.getTools()`

Returns the array of currently registered tool definitions.

### `ShrEdlyWebMCP.executeTool(name, args)`

Directly invoke a tool by name, bypassing `document.modelContext`. Useful for building your own tool-testing UI.

### `ShrEdlyWebMCP.stop()`

Stop polling.

---

## How tool discovery works

`document.modelContext` is a browser API provided by the ChatGPT desktop app when you browse to a page in its companion browser. This library calls `registerTool()` on that native API — it never installs a polyfill that could interfere with the browser's own implementation.

If `document.modelContext` isn't available yet when tools are fetched (it can initialize asynchronously), the library queues registrations and flushes them as soon as the API appears.

---

## Requirements

- Tools must be registered during initial page load (not behind a user interaction) for AI agents to discover them. This library does this automatically.
- The ChatGPT desktop app companion browser must be used — server-side browsing by the AI does not inject `document.modelContext`.
- `tools/list` on Shredly requires no authentication, so tools register immediately. `tools/call` injects the token from `getToken()` at invocation time.

---

## License

MIT
