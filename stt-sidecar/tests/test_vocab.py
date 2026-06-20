import json
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from vocab import load_vocab, load_corrections, apply_corrections


def test_load_vocab_joins_terms(tmp_path):
    d = tmp_path / "voice"; d.mkdir()
    (d / "voice-vocab.json").write_text(json.dumps({"terms": ["Tauri", "Riverpod"]}))
    assert load_vocab(tmp_path) == "Tauri Riverpod"


def test_load_vocab_missing_returns_empty(tmp_path):
    assert load_vocab(tmp_path) == ""


def test_load_corrections_missing_returns_empty(tmp_path):
    assert load_corrections(tmp_path) == []


def test_apply_corrections_word_boundary_case_insensitive():
    pairs = [("tori", "Tauri")]
    assert apply_corrections("i love tori and Tori", pairs) == "i love Tauri and Tauri"
    # substring inside another word is NOT replaced
    assert apply_corrections("category", pairs) == "category"
