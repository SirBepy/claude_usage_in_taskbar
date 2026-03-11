"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { app, session: electronSession } = require("electron");

let sqlLib = null; // lazy-loaded on first import

// ── Path helpers ──────────────────────────────────────────────────────────────

function getChromeDataDir() {
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  if (process.platform === "darwin")
    return path.join(process.env.HOME || "", "Library", "Application Support", "Google", "Chrome");
  return path.join(process.env.HOME || "", ".config", "google-chrome");
}

function chromeCookiesPath(dataDir, profileDir) {
  // Chrome 96+ moved cookies to a Network subfolder
  const network = path.join(dataDir, profileDir, "Network", "Cookies");
  if (fs.existsSync(network)) return network;
  const legacy = path.join(dataDir, profileDir, "Cookies");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

// ── Profile listing ───────────────────────────────────────────────────────────

function listChromeProfiles() {
  const dataDir = getChromeDataDir();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "Local State"), "utf8"));
    const cache = state?.profile?.info_cache ?? {};
    return Object.entries(cache)
      .map(([dir, info]) => ({
        dir,
        name: info.name || dir,
        email: info.user_name || "",
      }))
      .filter((p) => !!chromeCookiesPath(dataDir, p.dir));
  } catch {
    return [];
  }
}

// ── Cookie decryption ─────────────────────────────────────────────────────────

/**
 * Returns the AES key Chrome uses to encrypt cookies.
 * Win32: DPAPI-encrypted key stored in Local State.
 * macOS: PBKDF2 key derived from the Keychain password.
 */
function getChromeAesKey() {
  const dataDir = getChromeDataDir();

  if (process.platform === "win32") {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "Local State"), "utf8"));
    const encB64 = state?.os_crypt?.encrypted_key;
    if (!encB64) throw new Error("No os_crypt.encrypted_key in Chrome Local State");

    // Strip the literal 'DPAPI' prefix (5 bytes), then decrypt via Windows DPAPI.
    const encrypted = Buffer.from(encB64, "base64").slice(5);
    const scriptFile = path.join(app.getPath("temp"), "_claude_dpapi.ps1");
    try {
      fs.writeFileSync(
        scriptFile,
        [
          "Add-Type -AssemblyName System.Security",
          `$enc = [System.Convert]::FromBase64String('${encrypted.toString("base64")}')`,
          "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[System.Console]::WriteLine([System.Convert]::ToBase64String($dec))",
        ].join("\r\n"),
        "utf8",
      );
      const out = execSync(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`,
        { encoding: "utf8" },
      ).trim();
      return Buffer.from(out, "base64");
    } finally {
      try { fs.unlinkSync(scriptFile); } catch {}
    }
  }

  if (process.platform === "darwin") {
    const pw = execSync(
      'security find-generic-password -a "Chrome" -s "Chrome Safe Storage" -w',
      { encoding: "utf8" },
    ).trim();
    return crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  }

  throw new Error(`Chrome cookie import not yet supported on ${process.platform}`);
}

function decryptChromeValue(buf, aesKey) {
  if (!buf || buf.length < 4) return "";
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11") return ""; // pre-v80 DPAPI-only, skip

  try {
    if (process.platform === "win32") {
      // AES-256-GCM: [3-byte prefix][12-byte nonce][ciphertext][16-byte tag]
      const nonce = buf.slice(3, 15);
      const tag = buf.slice(buf.length - 16);
      const ct = buf.slice(15, buf.length - 16);
      const dec = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
      dec.setAuthTag(tag);
      return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
    }
    if (process.platform === "darwin") {
      // AES-128-CBC: [3-byte prefix][ciphertext], IV = 16 space chars
      const dec = crypto.createDecipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
      return Buffer.concat([dec.update(buf.slice(3)), dec.final()]).toString("utf8");
    }
  } catch {}
  return "";
}

// ── Locked file copy (Windows) ────────────────────────────────────────────────

/**
 * Copies a file that may be held open by Chrome.
 *
 * Chrome locks its Cookies SQLite file while running; plain fs.copyFileSync
 * fails with EBUSY. On Windows we use Win32 CreateFile with full share flags
 * (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE = 7) and
 * FILE_FLAG_BACKUP_SEMANTICS (0x02000000) via inline C# in PowerShell.
 * On macOS/Linux the OS uses advisory locks so a plain copy works.
 */
function safeCopyLockedFile(src, dst) {
  if (process.platform !== "win32") {
    fs.copyFileSync(src, dst);
    return;
  }

  const safeSrc = src.replace(/'/g, "''");
  const safeDst = dst.replace(/'/g, "''");
  const scriptFile = path.join(app.getPath("temp"), "_claude_copy.ps1");

  try {
    fs.writeFileSync(
      scriptFile,
      [
        '$ErrorActionPreference = "Stop"',
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.IO;",
        "using System.Runtime.InteropServices;",
        "using Microsoft.Win32.SafeHandles;",
        "public class ChromeCopier {",
        '    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
        "    static extern IntPtr CreateFile(",
        "        string lpFileName, uint dwDesiredAccess, uint dwShareMode,",
        "        IntPtr lpSecurityAttributes, uint dwCreationDisposition,",
        "        uint dwFlagsAndAttributes, IntPtr hTemplateFile);",
        "    public static void Copy(string src, string dst) {",
        "        // GENERIC_READ | FILE_SHARE_READ|WRITE|DELETE | OPEN_EXISTING | FILE_FLAG_BACKUP_SEMANTICS",
        "        IntPtr h = CreateFile(src, 0x80000000u, 7u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero);",
        "        if (h == new IntPtr(-1))",
        '            throw new Exception("Win32 error " + Marshal.GetLastWin32Error() + " opening Cookies file.");',
        "        using (var fs = new FileStream(new SafeFileHandle(h, true), FileAccess.Read))",
        "        using (var fd = File.Create(dst)) { fs.CopyTo(fd); }",
        "    }",
        "}",
        "'@",
        `[ChromeCopier]::Copy('${safeSrc}', '${safeDst}')`,
      ].join("\r\n"),
      "utf8",
    );

    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { encoding: "utf8" },
    );
  } catch (e) {
    const detail = ((e.stderr || "") + (e.stdout || "") + e.message).toString().trim();
    throw new Error(
      detail.includes("Win32") || detail.includes("being used") || detail.includes("error 32")
        ? 'Chrome has the Cookies file locked. Close Chrome and try again, or use "Sign in Fresh".'
        : `Failed to copy Chrome cookies: ${detail.slice(0, 300)}`,
    );
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Reads the Cookies SQLite database from the given Chrome profile directory,
 * decrypts the claude.ai cookies, and sets them in the default Electron session.
 * Returns the number of cookies imported.
 */
async function importChromeProfile(profileDir) {
  const dataDir = getChromeDataDir();
  const cookiesFile = chromeCookiesPath(dataDir, profileDir);
  if (!cookiesFile) throw new Error("No Cookies file found for this profile");

  const tmpFile = path.join(app.getPath("temp"), "_claude_cookies_tmp.db");
  const tmpWal = tmpFile + "-wal";
  const tmpShm = tmpFile + "-shm";

  safeCopyLockedFile(cookiesFile, tmpFile);

  // Also copy WAL/SHM if present so sql.js sees uncheckpointed writes.
  // Chrome flushes the refreshed sessionKey to WAL before checkpointing.
  const walSrc = cookiesFile + "-wal";
  const shmSrc = cookiesFile + "-shm";
  try { if (fs.existsSync(walSrc)) safeCopyLockedFile(walSrc, tmpWal); } catch {}
  try { if (fs.existsSync(shmSrc)) safeCopyLockedFile(shmSrc, tmpShm); } catch {}

  let imported = 0;
  try {
    if (!sqlLib) {
      const initSql = require("sql.js");
      sqlLib = await initSql({
        locateFile: (f) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", f),
      });
    }

    const aesKey = getChromeAesKey();

    // Load DB + WAL into sql.js virtual FS so SQLite applies WAL automatically.
    sqlLib.FS.mkdir("/ck");
    sqlLib.FS.writeFile("/ck/c.db", fs.readFileSync(tmpFile));
    if (fs.existsSync(tmpWal)) sqlLib.FS.writeFile("/ck/c.db-wal", fs.readFileSync(tmpWal));
    if (fs.existsSync(tmpShm)) sqlLib.FS.writeFile("/ck/c.db-shm", fs.readFileSync(tmpShm));

    const db = new sqlLib.Database("/ck/c.db");
    const res = db.exec(
      `SELECT name, value, encrypted_value, host_key, path, is_secure, is_httponly, expires_utc
       FROM cookies WHERE host_key LIKE '%claude.ai%'`,
    );
    db.close();

    if (!res.length) return 0;

    const cols = res[0].columns;
    for (const row of res[0].values) {
      const c = Object.fromEntries(cols.map((k, i) => [k, row[i]]));
      const val = c.value || decryptChromeValue(c.encrypted_value, aesKey);
      if (!val) continue;
      if (c.name === "sessionKey") console.log(`[chrome-import] sessionKey: ${val.slice(0, 30)}…`);

      // Chrome stores expiry as µs since 1601-01-01 (Windows FILETIME epoch).
      const exp = c.expires_utc ? c.expires_utc / 1e6 - 11644473600 : undefined;
      try {
        await electronSession.defaultSession.cookies.set({
          url: "https://claude.ai",
          name: c.name,
          value: val,
          domain: c.host_key,
          path: c.path || "/",
          secure: !!c.is_secure,
          httpOnly: !!c.is_httponly,
          ...(exp && exp > 0 ? { expirationDate: exp } : {}),
        });
        imported++;
      } catch (e) {
        console.warn(`[chrome-import] cookie ${c.name}: ${e.message}`);
      }
    }
  } finally {
    for (const f of [tmpFile, tmpWal, tmpShm]) {
      try { fs.unlinkSync(f); } catch {}
    }
    try { sqlLib.FS.unlink("/ck/c.db"); } catch {}
    try { sqlLib.FS.unlink("/ck/c.db-wal"); } catch {}
    try { sqlLib.FS.unlink("/ck/c.db-shm"); } catch {}
    try { sqlLib.FS.rmdir("/ck"); } catch {}
  }

  return imported;
}

module.exports = { listChromeProfiles, importChromeProfile };
