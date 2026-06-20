import pathlib, wave
import sys
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def _has_cuda():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _has_cuda(), reason="needs CUDA GPU")


def _pcm_from_wav(p):
    with wave.open(str(p), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        return w.readframes(w.getnframes())


def test_engine_transcribes_fixture(tmp_path):
    from engine import StreamingEngine
    eng = StreamingEngine(app_data=tmp_path)  # empty vocab dir is fine
    eng.reset()
    pcm = _pcm_from_wav(pathlib.Path(__file__).parent / "fixtures" / "hello.wav")
    out = ""
    step = int(16000 * 0.25) * 2  # 250 ms slices
    for i in range(0, len(pcm), step):
        out += eng.accept_pcm(pcm[i:i + step])["final"]
    out += eng.finish()
    assert "testing" in out.lower()
