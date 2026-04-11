"use strict";

const fs = require("fs");

/**
 * Best-effort decode of a Claude project dir name back to a filesystem path.
 * Claude encodes path separators, spaces, underscores, and colons (Windows)
 * all as "-".
 * Example: "c--Users-tecno-My-Project" → "c:\Users\tecno\My Project"
 *
 * Strategy: at each directory level, read the actual directory listing and find
 * the entry that matches the most remaining segments (longest match first).
 * Matching normalizes both sides (lowercase, -, " ", _ all mapped to the same
 * char). This correctly handles multi-word names like "claude_usage_in_taskbar"
 * without requiring intermediate paths to exist.
 */
function decodeCwd(encoded) {
  const sep = process.platform === "win32" ? "\\" : "/";
  let root, rawParts;

  if (process.platform === "win32") {
    const driveSep = encoded.indexOf("--");
    if (driveSep !== -1) {
      root = encoded.slice(0, driveSep) + ":" + sep;
      rawParts = encoded.slice(driveSep + 2).split("-");
    } else {
      return encoded;
    }
  } else {
    root = "/";
    rawParts = encoded.split("-");
  }

  // Collapse empty segments caused by "--" in the middle of the path.
  // Claude encodes "." (dot prefix) as "-", so ".claude" → "--claude" which
  // after splitting on "-" gives ["", "claude"]. Collapse these into ".claude".
  const parts = [];
  for (let i = 0; i < rawParts.length; i++) {
    if (rawParts[i] === "" && i + 1 < rawParts.length) {
      parts.push("." + rawParts[i + 1]);
      i++;
    } else {
      parts.push(rawParts[i]);
    }
  }

  const norm = (s) => s.toLowerCase().replace(/[-_ ]/g, "\0");

  let currentPath = root;
  let i = 0;

  while (i < parts.length) {
    let matched = false;

    try {
      const entries = fs.readdirSync(currentPath);
      const entryMap = new Map();
      for (const entry of entries) {
        entryMap.set(norm(entry), entry);
      }

      // Try consuming as many segments as possible (longest match first)
      for (let n = parts.length - i; n >= 1; n--) {
        const candidate = norm(parts.slice(i, i + n).join("-"));
        const entry = entryMap.get(candidate);
        if (entry) {
          currentPath += (currentPath.endsWith(sep) ? "" : sep) + entry;
          i += n;
          matched = true;
          break;
        }
      }
    } catch { /* directory unreadable, fall through */ }

    if (!matched) {
      currentPath += (currentPath.endsWith(sep) ? "" : sep) + parts[i];
      i++;
    }
  }

  return currentPath;
}

module.exports = { decodeCwd };
