"""Regression guard for the cold-start fix: the Whisper model must be built
once and shared across connections, not reloaded per StreamingEngine. Mocks the
ASR so it runs without a GPU."""
import pathlib, sys
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import engine


class FakeASR:
    instances = 0

    def __init__(self, *a, **k):
        FakeASR.instances += 1
        self.transcribe_kargs = {}

    def use_vad(self):
        pass


@pytest.fixture(autouse=True)
def _mock_asr(monkeypatch):
    monkeypatch.setattr(engine, "FasterWhisperASR", FakeASR)
    FakeASR.instances = 0


def test_build_asr_loads_model_once():
    engine.build_asr()
    assert FakeASR.instances == 1


def test_engines_reuse_shared_asr_without_reloading(tmp_path):
    asr = engine.build_asr()
    e1 = engine.StreamingEngine(app_data=tmp_path, asr=asr)
    e2 = engine.StreamingEngine(app_data=tmp_path, asr=asr)
    # The whole point: two connections, still exactly one model load.
    assert FakeASR.instances == 1
    assert e1.asr is asr and e2.asr is asr


def test_standalone_engine_still_loads_its_own(tmp_path):
    # asr=None path (e.g. the CUDA fixture test) must keep working.
    e = engine.StreamingEngine(app_data=tmp_path)
    assert FakeASR.instances == 1
    assert e.asr is not None
