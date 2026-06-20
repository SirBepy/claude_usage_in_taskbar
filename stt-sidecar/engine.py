# Streaming STT engine: faster-whisper large-v3 + ufal LocalAgreement-2
# (vendored whisper_online.py). Injects hotword vocab + applies the correction
# map. NO VAD: the engine never decides an utterance has ended.
import os
import sys
import importlib.util


def _add_nvidia_dll_dirs():
    """Windows: ctranslate2 loads cublas/cudnn by bare name with a LoadLibrary
    that does NOT honor `os.add_dll_directory`, so inference fails with
    'cublas64_12.dll is not found or cannot be loaded' even though the pip
    `nvidia-*-cu12` wheels ship the DLLs. Fix in two parts, before faster-whisper
    loads the model: (1) put every nvidia/*/bin on the DLL search path so
    inter-DLL deps resolve; (2) PRELOAD the key CUDA libs by full path so
    ctranslate2's later bare-name LoadLibrary finds the already-resident modules
    (bulletproof vs. search-path semantics). cudart loads first: cublas needs it."""
    if not sys.platform.startswith("win"):
        return
    import ctypes
    try:
        spec = importlib.util.find_spec("nvidia")
        roots = list(spec.submodule_search_locations) if spec else []
    except Exception:
        roots = []
    bindirs = []
    for root in roots:
        try:
            for sub in os.listdir(root):
                b = os.path.join(root, sub, "bin")
                if os.path.isdir(b):
                    bindirs.append(b)
        except Exception:
            pass
    for b in bindirs:
        try:
            os.add_dll_directory(b)
        except Exception:
            pass
        os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
    found = {}
    for b in bindirs:
        try:
            for name in os.listdir(b):
                if name.lower().endswith(".dll"):
                    found.setdefault(name, os.path.join(b, name))
        except Exception:
            pass
    for name in ("cudart64_12.dll", "cublasLt64_12.dll", "cublas64_12.dll", "cudnn64_9.dll"):
        p = found.get(name)
        if p:
            try:
                ctypes.WinDLL(p)
            except OSError:
                pass


_add_nvidia_dll_dirs()

import numpy as np
from whisper_online import FasterWhisperASR, OnlineASRProcessor
from vocab import load_vocab, load_corrections, apply_corrections


class StreamingEngine:
    def __init__(self, app_data, model_size="large-v3", lang="en"):
        self.app_data = app_data
        # FasterWhisperASR.load_model hardcodes device="cuda", compute_type="float16";
        # modelsize="large-v3" is auto-downloaded by faster-whisper on first use.
        self.asr = FasterWhisperASR(lan=lang, modelsize=model_size)
        self._hotwords = load_vocab(app_data)
        if self._hotwords:
            self.asr.transcribe_kargs["hotwords"] = self._hotwords
        self._corrections = load_corrections(app_data)
        self.online = None

    def reset(self):
        """Begin a fresh utterance."""
        self.online = OnlineASRProcessor(self.asr)
        self.online.init()

    def reload_vocab(self):
        self._hotwords = load_vocab(self.app_data)
        if self._hotwords:
            self.asr.transcribe_kargs["hotwords"] = self._hotwords
        else:
            self.asr.transcribe_kargs.pop("hotwords", None)
        self._corrections = load_corrections(self.app_data)

    def accept_pcm(self, pcm_i16le: bytes) -> dict:
        """Feed a chunk of raw 16-bit LE mono 16 kHz PCM.
        Returns {"final": newly-committed text (may be ""), "partial": uncommitted tail}."""
        audio = np.frombuffer(pcm_i16le, dtype="<i2").astype(np.float32) / 32768.0
        self.online.insert_audio_chunk(audio)
        _, _, text = self.online.process_iter()
        final = apply_corrections(text or "", self._corrections)
        # Uncommitted LocalAgreement tail = HypothesisBuffer.buffer, list of (beg,end,word).
        partial = ""
        buf = getattr(self.online, "transcript_buffer", None)
        if buf is not None and getattr(buf, "buffer", None):
            partial = " ".join(w[2] for w in buf.buffer).strip()
            partial = apply_corrections(partial, self._corrections)
        return {"final": final, "partial": partial}

    def finish(self) -> str:
        """Flush at end of utterance; return any trailing committed text."""
        if self.online is None:
            return ""
        _, _, text = self.online.finish()
        return apply_corrections(text or "", self._corrections)
