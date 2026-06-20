# STT sidecar: localhost-only WebSocket server on 127.0.0.1:27184.
# Binary frames = raw 16 kHz mono Int16LE PCM. Text frames = JSON control
# {"cmd": "start"|"stop"|"reload_vocab"|"shutdown"}. Emits JSON results.
import argparse, asyncio, json, pathlib, sys
import websockets
from engine import StreamingEngine


def make_handler(app_data):
    async def handle(ws):
        eng = StreamingEngine(app_data=pathlib.Path(app_data))
        await ws.send(json.dumps({"type": "ready"}))
        async for msg in ws:
            try:
                if isinstance(msg, (bytes, bytearray)):
                    out = eng.accept_pcm(bytes(msg))
                    if out["final"]:
                        await ws.send(json.dumps({"type": "final", "text": out["final"]}))
                    if out["partial"]:
                        await ws.send(json.dumps({"type": "partial", "text": out["partial"]}))
                    continue
                cmd = json.loads(msg).get("cmd")
                if cmd == "start":
                    eng.reset()
                elif cmd == "stop":
                    tail = eng.finish()
                    await ws.send(json.dumps({"type": "final", "text": tail}))
                elif cmd == "reload_vocab":
                    eng.reload_vocab()
                elif cmd == "shutdown":
                    await ws.close()
                    return
            except Exception as e:  # never let one bad frame kill the loop
                await ws.send(json.dumps({"type": "error", "message": str(e)}))
    return handle


async def _main(app_data, port):
    # max_size=None: binary audio frames must not hit the default 1 MiB cap.
    async with websockets.serve(make_handler(app_data), "127.0.0.1", port, max_size=None):
        print(f"stt-sidecar listening on 127.0.0.1:{port}", flush=True)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-data", required=True)
    ap.add_argument("--port", type=int, default=27184)
    a = ap.parse_args()
    try:
        asyncio.run(_main(a.app_data, a.port))
    except KeyboardInterrupt:
        sys.exit(0)
