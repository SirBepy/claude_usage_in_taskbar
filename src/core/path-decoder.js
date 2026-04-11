"use strict";

const fs = require("fs");

/**
 * Best-effort decode of a Claude project dir name back to a filesystem path.
 * Claude encodes path separators, spaces, underscores, and colons (Windows) all as "-".
 * Example: "c--Users-tecno-My-Project" → "c:\Users\tecno\My Project"
 *
 * We greedily walk the segments and check the filesystem. At each step we try
 * merging the next segment with "-", " ", or "_" (all encoded as "-" by Claude)
 * before falling back to treating it as a path separator.
 */
function decodeCwd(encoded) {
  const sep = process.platform === "win32" ? "\\" : "/";
  let root, parts;

  if (process.platform === "win32") {
    const driveSep = encoded.indexOf("--");
    if (driveSep !== -1) {
      root = encoded.slice(0, driveSep) + ":\\";
      parts = encoded.slice(driveSep + 2).split("-");
    } else {
      return encoded;
    }
  } else {
    root = "/";
    parts = encoded.split("-");
  }

  // Collapse empty segments caused by "--" in the middle of the path.
  // Claude encodes "." (dot prefix) as "-", so ".claude" → "--claude" which
  // after splitting on "-" gives ["", "claude"]. Collapse these into ".claude".
  const collapsed = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && i + 1 < parts.length) {
      collapsed.push("." + parts[i + 1]);
      i++;
    } else {
      collapsed.push(parts[i]);
    }
  }

  // Greedy walk: at each "-" boundary, prefer merging with "-" or " " when the
  // merged path exists on disk, falling back to treating it as a path separator.
  const resolved = [collapsed[0]];
  for (let i = 1; i < collapsed.length; i++) {
    const prefix = resolved.slice(0, -1);
    const last = resolved[resolved.length - 1];
    let merged = null;

    for (const joiner of ["-", " ", "_"]) {
      const candidate = last + joiner + collapsed[i];
      const candidatePath = root + prefix.concat(candidate).join(sep);
      try {
        fs.statSync(candidatePath);
        merged = candidate;
        break;
      } catch { /* try next joiner */ }
    }

    if (merged !== null) {
      resolved[resolved.length - 1] = merged;
    } else {
      resolved.push(collapsed[i]);
    }
  }

  return root + resolved.join(sep);
}

module.exports = { decodeCwd };
