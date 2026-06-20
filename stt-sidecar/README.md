# STT sidecar (host-PC only)

Self-hosted streaming speech-to-text for the voice-mode feature. Runs **only** on
the host PC (the one running the daemon); never bundled into app releases or run
on mobile/Linux. The daemon launches and supervises this automatically
(`src-tauri/src/daemon/stt.rs`); a manual run is for debugging only.

- **Engine:** `faster-whisper` `large-v3` on CUDA (FP16).
- **Streaming:** ufal LocalAgreement-2, vendored as `whisper_online.py` (MIT). No VAD.
- **Transport:** localhost WebSocket on `127.0.0.1:27184`. Binary = 16 kHz mono
  Int16LE PCM; text = JSON control (`start`/`stop`/`reload_vocab`/`shutdown`).

## One-time setup

```powershell
cd stt-sidecar
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

First transcription auto-downloads `large-v3` (~3 GB) to the HuggingFace cache.

## Verify

```powershell
# Fast (no GPU needed): vocab + protocol
.\.venv\Scripts\python.exe -m pytest tests/test_vocab.py tests/test_server.py -v
# Full (uses the GPU + downloads the model on first run):
.\.venv\Scripts\python.exe -m pytest tests/test_engine.py -v
```

`tests/fixtures/hello.wav` is a 16 kHz mono SAPI clip ("testing one two three")
used to verify end-to-end transcription without a microphone.

## Run manually (debug)

```powershell
.\.venv\Scripts\python.exe server.py --app-data "$env:APPDATA\claude-usage-tauri"
```

## Notes

- `whisper_online.py` is vendored from ufal/whisper_streaming with the top-level
  `librosa`/`soundfile` imports made optional (only the unused `load_audio`
  helpers needed them), so the heavy librosa dep tree isn't required.
- Hotword vocabulary lives in `<app-data>/voice/voice-vocab.json` (the daemon
  seeds it). Corrections (`voice-corrections.json`) are written by Plan 3.
