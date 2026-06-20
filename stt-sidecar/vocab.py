# Vocab + corrections loading for the STT sidecar. Pure, no heavy deps.
import json, pathlib, re


def _voice_dir(app_data: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(app_data) / "voice"


def load_vocab(app_data: pathlib.Path) -> str:
    """Return a single space-joined hotword string from <app_data>/voice/voice-vocab.json.
    Empty string when the file is missing or unreadable."""
    f = _voice_dir(app_data) / "voice-vocab.json"
    if not f.exists():
        return ""
    try:
        terms = json.loads(f.read_text(encoding="utf-8")).get("terms", [])
    except (json.JSONDecodeError, OSError):
        return ""
    return " ".join(t.strip() for t in terms if isinstance(t, str) and t.strip())


def load_corrections(app_data: pathlib.Path):
    """Return [(heard, corrected)] from voice-corrections.json (written by Plan 3).
    Empty list when the file is absent or malformed."""
    f = _voice_dir(app_data) / "voice-corrections.json"
    if not f.exists():
        return []
    try:
        pairs = json.loads(f.read_text(encoding="utf-8")).get("pairs", [])
    except (json.JSONDecodeError, OSError):
        return []
    return [
        (p["heard"], p["corrected"])
        for p in pairs
        if isinstance(p, dict) and p.get("heard") and p.get("corrected")
    ]


def apply_corrections(text: str, pairs) -> str:
    """Case-insensitive, whole-word replacement of each `heard` with `corrected`."""
    for heard, corrected in pairs:
        text = re.sub(rf"\b{re.escape(heard)}\b", corrected, text, flags=re.IGNORECASE)
    return text
