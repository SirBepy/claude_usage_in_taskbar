"use strict";

const express = require("express");
const crypto = require("crypto");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: "5mb" }));

const db = initDb();

// ── Middleware: API key auth ─��───────────────────────────────────────────────
function requireAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ error: "Missing x-api-key header" });

  const device = db
    .prepare("SELECT d.*, u.id AS userId FROM devices d JOIN users u ON d.user_id = u.id WHERE d.api_key = ?")
    .get(key);

  if (!device) return res.status(401).json({ error: "Invalid API key" });

  req.device = device;
  req.userId = device.userId;
  next();
}

// ���─ Routes: Registration ───���─────────────────────────────────────────────────

/**
 * POST /api/register
 * Body: { deviceName: "My PC" }
 * Creates a new user + first device. Returns { userId, apiKey, deviceId }.
 */
app.post("/api/register", (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) return res.status(400).json({ error: "deviceName required" });

  const userId = crypto.randomUUID();
  const apiKey = `cus_${crypto.randomBytes(24).toString("hex")}`;
  const deviceId = crypto.randomUUID();

  db.prepare("INSERT INTO users (id, created_at) VALUES (?, datetime('now'))").run(userId);
  db.prepare(
    "INSERT INTO devices (id, user_id, name, api_key, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(deviceId, userId, deviceName, apiKey);

  res.json({ userId, apiKey, deviceId });
});

/**
 * POST /api/link
 * Body: { linkCode, deviceName }
 * Links a new device to an existing user via a link code.
 */
app.post("/api/link", (req, res) => {
  const { linkCode, deviceName } = req.body;
  if (!linkCode || !deviceName) {
    return res.status(400).json({ error: "linkCode and deviceName required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE link_code = ? AND link_expires_at > datetime('now')").get(linkCode);
  if (!user) return res.status(404).json({ error: "Invalid or expired link code" });

  const apiKey = `cus_${crypto.randomBytes(24).toString("hex")}`;
  const deviceId = crypto.randomUUID();

  db.prepare(
    "INSERT INTO devices (id, user_id, name, api_key, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(deviceId, user.id, deviceName, apiKey);

  // Clear the link code after use
  db.prepare("UPDATE users SET link_code = NULL, link_expires_at = NULL WHERE id = ?").run(user.id);

  res.json({ userId: user.id, apiKey, deviceId });
});

/**
 * POST /api/link-code
 * Authenticated. Generates a short-lived link code for the user.
 */
app.post("/api/link-code", requireAuth, (req, res) => {
  const code = crypto.randomBytes(4).toString("hex"); // 8 chars
  db.prepare(
    "UPDATE users SET link_code = ?, link_expires_at = datetime('now', '+15 minutes') WHERE id = ?"
  ).run(code, req.userId);

  res.json({ linkCode: code, expiresInMinutes: 15 });
});

// ── Routes: Usage sync ───────────────────��──────────────��───────────────────

/**
 * POST /api/usage/push
 * Authenticated. Body: { snapshots: [...], tokenSessions: [...] }
 * Pushes usage history snapshots and token session records.
 */
app.post("/api/usage/push", requireAuth, (req, res) => {
  const { snapshots, tokenSessions } = req.body;
  let snapshotCount = 0;
  let sessionCount = 0;

  const insertSnapshot = db.prepare(`
    INSERT OR REPLACE INTO usage_snapshots (user_id, device_id, hour, session_pct, weekly_pct, session_resets_at, weekly_resets_at, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertToken = db.prepare(`
    INSERT OR IGNORE INTO token_sessions (user_id, device_id, session_id, cwd, date, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, turns, started_at, last_active_at, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    if (Array.isArray(snapshots)) {
      for (const s of snapshots) {
        insertSnapshot.run(
          req.userId, req.device.id, s.hour,
          s.session_pct, s.weekly_pct,
          s.session_resets_at, s.weekly_resets_at,
          s.recorded_at
        );
        snapshotCount++;
      }
    }

    if (Array.isArray(tokenSessions)) {
      for (const t of tokenSessions) {
        insertToken.run(
          req.userId, req.device.id, t.sessionId,
          t.cwd, t.date,
          t.inputTokens, t.outputTokens,
          t.cacheReadTokens, t.cacheCreationTokens,
          t.turns, t.startedAt, t.lastActiveAt,
          t.recordedAt
        );
        sessionCount++;
      }
    }
  });

  tx();

  // Update last sync time
  db.prepare("UPDATE devices SET last_sync_at = datetime('now') WHERE id = ?").run(req.device.id);

  res.json({ ok: true, snapshots: snapshotCount, tokenSessions: sessionCount });
});

/**
 * GET /api/usage/pull?since=<ISO8601>
 * Authenticated. Returns merged usage data from all linked devices.
 */
app.get("/api/usage/pull", requireAuth, (req, res) => {
  const since = req.query.since || "1970-01-01T00:00:00Z";

  const snapshots = db.prepare(`
    SELECT hour, session_pct, weekly_pct, session_resets_at, weekly_resets_at, recorded_at, d.name AS device_name
    FROM usage_snapshots s
    JOIN devices d ON d.id = s.device_id
    WHERE s.user_id = ? AND s.recorded_at > ?
    ORDER BY s.hour ASC
  `).all(req.userId, since);

  const tokenSessions = db.prepare(`
    SELECT session_id AS sessionId, cwd, date, input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
           turns, started_at AS startedAt, last_active_at AS lastActiveAt, recorded_at AS recordedAt,
           d.name AS deviceName
    FROM token_sessions t
    JOIN devices d ON d.id = t.device_id
    WHERE t.user_id = ? AND t.recorded_at > ?
    ORDER BY t.started_at ASC
  `).all(req.userId, since);

  res.json({ snapshots, tokenSessions });
});

/**
 * GET /api/devices
 * Authenticated. Lists all devices linked to this user.
 */
app.get("/api/devices", requireAuth, (req, res) => {
  const devices = db.prepare(
    "SELECT id, name, created_at, last_sync_at FROM devices WHERE user_id = ?"
  ).all(req.userId);

  res.json({ devices });
});

/**
 * DELETE /api/devices/:deviceId
 * Authenticated. Removes a device and its data.
 */
app.delete("/api/devices/:deviceId", requireAuth, (req, res) => {
  const { deviceId } = req.params;
  const device = db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(deviceId, req.userId);
  if (!device) return res.status(404).json({ error: "Device not found" });

  db.prepare("DELETE FROM usage_snapshots WHERE device_id = ?").run(deviceId);
  db.prepare("DELETE FROM token_sessions WHERE device_id = ?").run(deviceId);
  db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);

  res.json({ ok: true });
});

// ── Health check ───────────────────────────��─────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

app.listen(PORT, () => {
  console.log(`[sync-server] Listening on port ${PORT}`);
});
