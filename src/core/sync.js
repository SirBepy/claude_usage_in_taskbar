"use strict";

const { app, net } = require("electron");
const fs = require("fs");
const path = require("path");

const SYNC_STATE_PATH = path.join(app.getPath("userData"), "sync-state.json");

/**
 * Sync client for the Claude Usage sync backend.
 * Pushes usage snapshots and token sessions after each poll,
 * and pulls merged data from all linked devices.
 */
class SyncClient {
  constructor({ getSettings, loadHistory, loadTokenHistory }) {
    this._getSettings = getSettings;
    this._loadHistory = loadHistory;
    this._loadTokenHistory = loadTokenHistory;
    this._lastPushAt = null;
    this._loadState();
  }

  _loadState() {
    try {
      if (fs.existsSync(SYNC_STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(SYNC_STATE_PATH, "utf8"));
        this._lastPushAt = data.lastPushAt || null;
      }
    } catch {
      this._lastPushAt = null;
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify({
        lastPushAt: this._lastPushAt,
      }, null, 2));
    } catch (e) {
      console.error("[sync] Failed to save state:", e.message);
    }
  }

  _getSyncConfig() {
    const settings = this._getSettings();
    const sync = settings.sync || {};
    return {
      enabled: sync.enabled === true,
      serverUrl: (sync.serverUrl || "").replace(/\/$/, ""),
      apiKey: sync.apiKey || "",
      deviceName: sync.deviceName || "",
    };
  }

  /**
   * Push local usage data to the sync server.
   * Called after each successful poll.
   */
  async push() {
    const config = this._getSyncConfig();
    if (!config.enabled || !config.serverUrl || !config.apiKey) return;

    try {
      const history = this._loadHistory();
      const tokenHistory = this._loadTokenHistory();

      // Only push records newer than last push
      const since = this._lastPushAt || "1970-01-01T00:00:00Z";
      const newSnapshots = history.filter((r) => r.recorded_at > since);
      const newTokens = tokenHistory.filter((r) => r.recordedAt > since);

      if (newSnapshots.length === 0 && newTokens.length === 0) return;

      const resp = await this._fetch(`${config.serverUrl}/api/usage/push`, {
        method: "POST",
        body: JSON.stringify({
          snapshots: newSnapshots,
          tokenSessions: newTokens,
        }),
      }, config.apiKey);

      if (resp.ok) {
        this._lastPushAt = new Date().toISOString();
        this._saveState();
        console.log(`[sync] Pushed ${newSnapshots.length} snapshots, ${newTokens.length} token sessions`);
      } else {
        console.error("[sync] Push failed:", resp.status);
      }
    } catch (e) {
      console.error("[sync] Push error:", e.message);
    }
  }

  /**
   * Pull merged usage data from all linked devices.
   * Returns { snapshots, tokenSessions } or null on failure.
   */
  async pull() {
    const config = this._getSyncConfig();
    if (!config.enabled || !config.serverUrl || !config.apiKey) return null;

    try {
      const since = this._lastPushAt || "1970-01-01T00:00:00Z";
      const resp = await this._fetch(
        `${config.serverUrl}/api/usage/pull?since=${encodeURIComponent(since)}`,
        { method: "GET" },
        config.apiKey
      );

      if (resp.ok) {
        return resp.data;
      }
      console.error("[sync] Pull failed:", resp.status);
      return null;
    } catch (e) {
      console.error("[sync] Pull error:", e.message);
      return null;
    }
  }

  /**
   * Register a new account on the sync server.
   * Returns { userId, apiKey, deviceId } or throws.
   */
  async register(serverUrl, deviceName) {
    const resp = await this._fetch(`${serverUrl}/api/register`, {
      method: "POST",
      body: JSON.stringify({ deviceName }),
    });

    if (!resp.ok) throw new Error(resp.data?.error || `HTTP ${resp.status}`);
    return resp.data;
  }

  /**
   * Generate a link code for adding another device.
   */
  async generateLinkCode() {
    const config = this._getSyncConfig();
    if (!config.serverUrl || !config.apiKey) throw new Error("Sync not configured");

    const resp = await this._fetch(`${config.serverUrl}/api/link-code`, {
      method: "POST",
      body: "{}",
    }, config.apiKey);

    if (!resp.ok) throw new Error(resp.data?.error || `HTTP ${resp.status}`);
    return resp.data;
  }

  /**
   * Link this device to an existing account via link code.
   */
  async link(serverUrl, linkCode, deviceName) {
    const resp = await this._fetch(`${serverUrl}/api/link`, {
      method: "POST",
      body: JSON.stringify({ linkCode, deviceName }),
    });

    if (!resp.ok) throw new Error(resp.data?.error || `HTTP ${resp.status}`);
    return resp.data;
  }

  /**
   * List all devices linked to this account.
   */
  async listDevices() {
    const config = this._getSyncConfig();
    if (!config.serverUrl || !config.apiKey) throw new Error("Sync not configured");

    const resp = await this._fetch(`${config.serverUrl}/api/devices`, {
      method: "GET",
    }, config.apiKey);

    if (!resp.ok) throw new Error(resp.data?.error || `HTTP ${resp.status}`);
    return resp.data.devices;
  }

  /**
   * Make an HTTP request using Electron's net module.
   * Returns { ok, status, data }.
   */
  _fetch(url, options = {}, apiKey = null) {
    return new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(url);
        const request = net.request({
          method: options.method || "GET",
          url: url,
        });

        request.setHeader("Content-Type", "application/json");
        if (apiKey) request.setHeader("x-api-key", apiKey);

        let responseData = "";

        request.on("response", (response) => {
          response.on("data", (chunk) => { responseData += chunk.toString(); });
          response.on("end", () => {
            let data = null;
            try { data = JSON.parse(responseData); } catch {}
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              data,
            });
          });
        });

        request.on("error", (e) => {
          reject(e);
        });

        if (options.body) {
          request.write(options.body);
        }
        request.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}

module.exports = { SyncClient };
