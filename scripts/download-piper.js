"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");

const TARGET_PLATFORM = process.env.PIPER_PLATFORM || process.platform;
const TARGET_ARCH = process.env.PIPER_ARCH || process.arch;
const RESOURCES_DIR = path.join(__dirname, "..", "resources", "piper");

const PIPER_VERSION = "2023.11.14-2";
const PIPER_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;

const PIPER_ARCHIVE = {
  "win32_x64": "piper_windows_amd64.zip",
  "darwin_arm64": "piper_macos_aarch64.tar.gz",
  "darwin_x64": "piper_macos_x64.tar.gz",
  "linux_x64": "piper_linux_x86_64.tar.gz",
  "linux_arm64": "piper_linux_aarch64.tar.gz",
};

const VOICES = [
  { id: "en_US-amy-medium", path: "en/en_US/amy/medium" },
  { id: "en_US-ryan-medium", path: "en/en_US/ryan/medium" },
  { id: "en_GB-alba-medium", path: "en/en_GB/alba/medium" },
  { id: "en_US-lessac-high", path: "en/en_US/lessac/high" },
];

const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "ClaudeUsageTray-Installer" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      let lastLog = 0;
      res.on("data", (chunk) => {
        got += chunk.length;
        if (total && got - lastLog > 2 * 1024 * 1024) {
          lastLog = got;
          process.stdout.write(`\r  ${(got / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        process.stdout.write(`\r  done (${(got / 1048576).toFixed(1)}MB)${" ".repeat(20)}\n`);
        file.close(() => resolve());
      });
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const isZip = archivePath.toLowerCase().endsWith(".zip");
    if (isZip && process.platform === "win32") {
      const cmd = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], (err, stdout, stderr) => {
        if (err) reject(new Error(`Expand-Archive failed: ${err.message} ${stderr || ""}`));
        else resolve();
      });
    } else {
      const archiveName = path.basename(archivePath);
      const cwd = path.dirname(archivePath);
      execFile("tar", ["-xf", archiveName, "-C", destDir], { cwd }, (err) => {
        if (err) reject(new Error(`tar extract failed: ${err.message}`));
        else resolve();
      });
    }
  });
}

function getPiperBinaryPath() {
  const exe = TARGET_PLATFORM === "win32" ? "piper.exe" : "piper";
  return path.join(RESOURCES_DIR, "bin", `${TARGET_PLATFORM}_${TARGET_ARCH}`, "piper", exe);
}

function getVoicePath(voiceId) {
  return path.join(RESOURCES_DIR, "voices", `${voiceId}.onnx`);
}

async function installBinary() {
  const key = `${TARGET_PLATFORM}_${TARGET_ARCH}`;
  const archiveName = PIPER_ARCHIVE[key];
  if (!archiveName) {
    console.warn(`[piper] unsupported platform ${key}, skipping binary`);
    return;
  }
  const binPath = getPiperBinaryPath();
  if (fs.existsSync(binPath)) {
    console.log(`[piper] binary already present for ${key}`);
    return;
  }
  const destDir = path.dirname(path.dirname(binPath));
  fs.mkdirSync(destDir, { recursive: true });
  const archivePath = path.join(destDir, archiveName);
  console.log(`[piper] downloading engine ${archiveName}...`);
  await downloadFile(`${PIPER_BASE}/${archiveName}`, archivePath);
  console.log(`[piper] extracting engine...`);
  await extractArchive(archivePath, destDir);
  try { fs.unlinkSync(archivePath); } catch {}
  if (TARGET_PLATFORM !== "win32") {
    try { fs.chmodSync(binPath, 0o755); } catch {}
  }
  if (!fs.existsSync(binPath)) throw new Error("binary missing after extract");
}

async function installVoice(voice) {
  const onnxPath = getVoicePath(voice.id);
  const jsonPath = onnxPath + ".json";
  const onnxOk = fs.existsSync(onnxPath) && fs.statSync(onnxPath).size > 0;
  const jsonOk = fs.existsSync(jsonPath) && fs.statSync(jsonPath).size > 0;
  if (onnxOk && jsonOk) {
    console.log(`[piper] voice ${voice.id} already present`);
    return;
  }
  try { if (fs.existsSync(onnxPath)) fs.unlinkSync(onnxPath); } catch {}
  try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch {}
  console.log(`[piper] downloading voice ${voice.id}...`);
  await downloadFile(`${VOICE_BASE}/${voice.path}/${voice.id}.onnx`, onnxPath);
  await downloadFile(`${VOICE_BASE}/${voice.path}/${voice.id}.onnx.json`, jsonPath);
}

async function main() {
  if (process.env.SKIP_PIPER_DOWNLOAD === "1") {
    console.log("[piper] SKIP_PIPER_DOWNLOAD=1, skipping");
    return;
  }
  try {
    await installBinary();
    for (const voice of VOICES) {
      await installVoice(voice);
    }
    console.log("[piper] all assets ready");
  } catch (e) {
    console.warn(`[piper] download failed: ${e.message}`);
    console.warn("[piper] continuing without bundled TTS; runtime download will be available");
  }
}

main();
