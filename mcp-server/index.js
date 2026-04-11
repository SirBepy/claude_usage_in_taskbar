#!/usr/bin/env node
"use strict";

/**
 * Claude Usage MCP Server
 *
 * Standalone MCP server for non-app machines. Reads local Claude usage data
 * (JSONL logs from Claude Code) and pushes to the sync backend.
 *
 * Configuration via environment variables:
 *   SYNC_SERVER_URL - URL of the sync backend
 *   SYNC_API_KEY    - API key for authentication
 *   DEVICE_NAME     - Name for this device (default: hostname)
 *
 * Claude Code MCP config entry:
 * {
 *   "mcpServers": {
 *     "claude-usage": {
 *       "command": "npx",
 *       "args": ["claude-usage-mcp"],
 *       "env": {
 *         "SYNC_SERVER_URL": "https://your-server.onrender.com",
 *         "SYNC_API_KEY": "cus_..."
 *       }
 *     }
 *   }
 * }
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || "";
const SYNC_API_KEY = process.env.SYNC_API_KEY || "";
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

// ── Claude data paths ────────────────────────────────────────────────────────
function getClaudeDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude");
  }
  return path.join(os.homedir(), ".config", "Claude");
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
function syncFetch(urlStr, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SYNC_API_KEY,
      },
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Usage data reading ───────────────────────────────────────────────────────
function readLocalUsageHistory() {
  // Try to read from the Claude Usage app's data directory
  const appDataPaths = [
    path.join(process.env.APPDATA || "", "claude-usage-taskbar-tool", "usage-history.json"),
    path.join(os.homedir(), "Library", "Application Support", "claude-usage-taskbar-tool", "usage-history.json"),
    path.join(os.homedir(), ".config", "claude-usage-taskbar-tool", "usage-history.json"),
  ];

  for (const p of appDataPaths) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {}
  }
  return [];
}

function readLocalTokenHistory() {
  const appDataPaths = [
    path.join(process.env.APPDATA || "", "claude-usage-taskbar-tool", "token-history.json"),
    path.join(os.homedir(), "Library", "Application Support", "claude-usage-taskbar-tool", "token-history.json"),
    path.join(os.homedir(), ".config", "claude-usage-taskbar-tool", "token-history.json"),
  ];

  for (const p of appDataPaths) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {}
  }
  return [];
}

// ── MCP Server (stdio transport) ─────────────────────────────────────────────
// Minimal MCP implementation using stdio JSON-RPC
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });

const tools = [
  {
    name: "get_usage",
    description: "Get local Claude usage history (session and weekly utilization percentages)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_token_stats",
    description: "Get local Claude Code token usage statistics",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_push",
    description: "Push local usage data to the sync server",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_pull",
    description: "Pull merged usage data from all linked devices",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleToolCall(name) {
  if (name === "get_usage") {
    const history = readLocalUsageHistory();
    const latest = history[history.length - 1];
    return JSON.stringify({
      latest: latest || null,
      totalSnapshots: history.length,
    });
  }

  if (name === "get_token_stats") {
    const tokens = readLocalTokenHistory();
    const total = tokens.reduce(
      (acc, t) => ({
        input: acc.input + (t.inputTokens || 0),
        output: acc.output + (t.outputTokens || 0),
        sessions: acc.sessions + 1,
      }),
      { input: 0, output: 0, sessions: 0 }
    );
    return JSON.stringify({ total, recentSessions: tokens.slice(-5) });
  }

  if (name === "sync_push") {
    if (!SYNC_SERVER_URL || !SYNC_API_KEY) {
      return JSON.stringify({ error: "SYNC_SERVER_URL and SYNC_API_KEY env vars required" });
    }
    const snapshots = readLocalUsageHistory();
    const tokenSessions = readLocalTokenHistory();
    const result = await syncFetch(`${SYNC_SERVER_URL}/api/usage/push`, "POST", { snapshots, tokenSessions });
    return JSON.stringify(result.data);
  }

  if (name === "sync_pull") {
    if (!SYNC_SERVER_URL || !SYNC_API_KEY) {
      return JSON.stringify({ error: "SYNC_SERVER_URL and SYNC_API_KEY env vars required" });
    }
    const result = await syncFetch(`${SYNC_SERVER_URL}/api/usage/pull?since=1970-01-01T00:00:00Z`, "GET");
    return JSON.stringify(result.data);
  }

  return JSON.stringify({ error: "Unknown tool" });
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-usage-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return; // No response needed
  }

  if (method === "tools/list") {
    sendResponse(id, { tools });
    return;
  }

  if (method === "tools/call") {
    try {
      const text = await handleToolCall(params.name);
      sendResponse(id, { content: [{ type: "text", text }] });
    } catch (e) {
      sendResponse(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
});

process.stderr.write("[claude-usage-mcp] Server started\n");
