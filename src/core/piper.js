"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { app } = require("electron");

const PIPER_VERSION = "2023.11.14-2";
const PIPER_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;

const PIPER_ARCHIVE = {
  win32_x64: "piper_windows_amd64.zip",
  darwin_arm64: "piper_macos_aarch64.tar.gz",
  darwin_x64: "piper_macos_x64.tar.gz",
  linux_x64: "piper_linux_x86_64.tar.gz",
  linux_arm64: "piper_linux_aarch64.tar.gz",
};

const VOICES = [
  { id: "en_US-amy-medium", label: "Amy (US Female)", path: "en/en_US/amy/medium" },
  { id: "en_US-ryan-medium", label: "Ryan (US Male)", path: "en/en_US/ryan/medium" },
  { id: "en_GB-alba-medium", label: "Alba (UK Female)", path: "en/en_GB/alba/medium" },
  { id: "en_US-lessac-high", label: "Lessac (US, HQ)", path: "en/en_US/lessac/high" },
];

const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

function platformKey() {
  const key = `${process.platform}_${process.arch}`;
  return PIPER_ARCHIVE[key] ? key : null;
}

function getBundledRoot() {
  const isPackaged = app.isPackaged;
  if (isPackaged) return path.join(process.resourcesPath, "piper");
  return path.join(__dirname, "..", "..", "resources", "piper");
}

function getUserRoot() {
  return path.join(app.getPath("userData"), "piper");
}

function getBundledBinary() {
  const exe = process.platform === "win32" ? "piper.exe" : "piper";
  return path.join(getBundledRoot(), "bin", `${process.platform}_${process.arch}`, "piper", exe);
}

function getUserBinary() {
  const exe = process.platform === "win32" ? "piper.exe" : "piper";
  return path.join(getUserRoot(), "piper", exe);
}

function getPiperBinary() {
  const bundled = getBundledBinary();
  if (fs.existsSync(bundled)) return bundled;
  return getUserBinary();
}

function getBundledVoicePath(voiceId) {
  return path.join(getBundledRoot(), "voices", voiceId + ".onnx");
}

function getUserVoicePath(voiceId) {
  return path.join(getUserRoot(), "voices", voiceId + ".onnx");
}

function getVoicePath(voiceId) {
  const bundled = getBundledVoicePath(voiceId);
  if (fs.existsSync(bundled)) return bundled;
  return getUserVoicePath(voiceId);
}

function getVoiceJsonPath(voiceId) {
  return getVoicePath(voiceId) + ".json";
}

function isPiperInstalled() {
  try { return fs.existsSync(getPiperBinary()); } catch { return false; }
}

function isVoiceInstalled(voiceId) {
  try {
    const onnx = getVoicePath(voiceId);
    const json = getVoiceJsonPath(voiceId);
    if (!fs.existsSync(onnx) || !fs.existsSync(json)) return false;
    return fs.statSync(onnx).size > 0 && fs.statSync(json).size > 0;
  } catch { return false; }
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "ClaudeUsageTray" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      res.on("data", (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got / total);
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
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

async function installPiperBinary(onProgress) {
  const key = platformKey();
  if (!key) throw new Error(`Unsupported platform: ${process.platform}_${process.arch}`);
  const archiveName = PIPER_ARCHIVE[key];
  const url = `${PIPER_BASE}/${archiveName}`;
  const root = getUserRoot();
  fs.mkdirSync(root, { recursive: true });
  const archivePath = path.join(root, archiveName);
  await downloadFile(url, archivePath, onProgress);
  await extractArchive(archivePath, root);
  try { fs.unlinkSync(archivePath); } catch {}
  if (process.platform !== "win32") {
    try { fs.chmodSync(getUserBinary(), 0o755); } catch {}
  }
  if (!isPiperInstalled()) throw new Error("Piper binary missing after extraction");
}

async function installVoice(voiceId, onProgress) {
  const voice = VOICES.find(v => v.id === voiceId);
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`);
  const onnxUrl = `${VOICE_BASE}/${voice.path}/${voice.id}.onnx`;
  const jsonUrl = `${VOICE_BASE}/${voice.path}/${voice.id}.onnx.json`;
  const onnxDest = getUserVoicePath(voiceId);
  const jsonDest = onnxDest + ".json";
  await downloadFile(onnxUrl, onnxDest, p => onProgress && onProgress(p * 0.98));
  await downloadFile(jsonUrl, jsonDest, p => onProgress && onProgress(0.98 + p * 0.02));
}

function speak(text, voiceId) {
  return new Promise((resolve, reject) => {
    if (!isPiperInstalled()) return reject(new Error("Piper not installed"));
    if (!isVoiceInstalled(voiceId)) return reject(new Error(`Voice ${voiceId} not installed`));
    const outPath = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const proc = spawn(getPiperBinary(), ["--model", getVoicePath(voiceId), "--output_file", outPath], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(`Piper exited ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

function getInstallStatus() {
  return {
    piperInstalled: isPiperInstalled(),
    voices: VOICES.map(v => ({ ...v, installed: isVoiceInstalled(v.id) })),
    platformSupported: platformKey() !== null,
  };
}

module.exports = {
  VOICES,
  isPiperInstalled,
  isVoiceInstalled,
  installPiperBinary,
  installVoice,
  speak,
  getInstallStatus,
};
