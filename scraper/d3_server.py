#!/usr/bin/env python3
"""
Hosts the vllm-sr/d3 decision model on this computer's GPU, so the scraper pipeline can classify
postings without loading a 27B model on every run.

  python scraper/d3_server.py                       # http://127.0.0.1:8765, model from D3_MODEL (default vllm-sr/d3)
  python scraper/d3_server.py --port 8765 --revision <commit>

On Windows, scraper/start_d3_server.ps1 starts it in the background (setup_d3.ps1 also makes it start
when you sign in). The model is loaded once (about 52 GB of GPU memory in bfloat16, a minute or two),
then every request is answered from memory.

Endpoints (localhost only unless --allow-remote):
  GET  /health         {"ok": true, "model": ..., "revision": ..., "device": ..., "gpu": ...}
  POST /v1/systemone   {"state": "<text>", "questions": {...}}  ->  {"answers": {...}, "ms": 123}
                       the same arguments as the model card's model.system_one(...). Text only: images and
                       videos aren't accepted, so the server never fetches files or URLs on anyone's behalf.

Settings come from the command line, else the environment, else .env.local at the repository root:
D3_MODEL, D3_REVISION (pin the model's code to a reviewed commit), D3_PORT.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("d3_server")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL = "vllm-sr/d3"
DEFAULT_PORT = 8765
MAX_BODY = 1_000_000          # bytes per request
MAX_STATE = 60_000            # characters of posting text
MAX_QUESTIONS = 12
SAMPLE = ("Internship title: 2027 Summer Intern - Clinical Pharmacology Modeling\nCompany: Genentech\n\n"
          "Build population PK/PD models in R and NONMEM for Phase 2 trials and automate simulation workflows in Python.")


def setting(name: str, default: str = "") -> str:
    """From the environment, else .env.local / .env at the repository root."""
    if os.environ.get(name):
        return os.environ[name]
    for fname in (".env.local", ".env"):
        path = os.path.join(ROOT, fname)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                k, sep, v = line.strip().partition("=")
                if sep and k.removeprefix("export ").strip() == name and v.strip():
                    return v.strip().strip('"').strip("'")
    return default


def jsonable(x):
    """Model answers may hold tensors or numpy numbers; turn them into plain JSON values."""
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, (str, int, float, bool)) or x is None:
        return x
    if hasattr(x, "item"):
        try:
            return x.item()
        except (ValueError, RuntimeError):
            pass
    if hasattr(x, "tolist"):
        return jsonable(x.tolist())
    return str(x)


def check_request(body: object) -> tuple[str, dict]:
    """The state text and questions from a request body, or ValueError saying what's wrong."""
    if not isinstance(body, dict):
        raise ValueError('send JSON: {"state": "...", "questions": {...}}')
    if set(body) - {"state", "questions"}:
        raise ValueError("only text requests are accepted: state and questions (no images or videos)")
    state, questions = body.get("state"), body.get("questions")
    if not isinstance(state, str) or not state.strip():
        raise ValueError("state must be non-empty text")
    if len(state) > MAX_STATE:
        raise ValueError(f"state is longer than {MAX_STATE} characters")
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        raise ValueError(f"questions must be an object with 1 to {MAX_QUESTIONS} questions")
    for key, q in questions.items():
        if not isinstance(q, dict) or q.get("type") not in ("choice", "noul", "score") or not isinstance(q.get("instructions"), str):
            raise ValueError(f"question {key!r} needs a type (choice, noul or score) and instructions")
    return state, questions


class Model:
    """vllm-sr/d3 loaded once; one request on the GPU at a time."""

    def __init__(self, name: str, revision: str | None):
        import torch
        from transformers import AutoModel
        if not torch.cuda.is_available():
            raise RuntimeError("PyTorch can't see an NVIDIA GPU. d3 needs about 60 GB of GPU memory "
                               "(run scraper/setup_d3.ps1, which installs PyTorch built for CUDA).")
        self.torch = torch
        self.name, self.revision = name, revision or ""
        self.device = "cuda"
        self.gpu = torch.cuda.get_device_name(0)
        started = time.monotonic()
        log.info("loading %s%s on %s (%s); the first run downloads about 52 GB", name,
                 f" @ {revision[:12]}" if revision else "", self.device, self.gpu)
        self.model = AutoModel.from_pretrained(name, trust_remote_code=True, dtype=torch.bfloat16, revision=revision or None)
        self.model.to(self.device).eval()
        self.lock = threading.Lock()
        self.loaded_at = datetime.now().isoformat(timespec="seconds")
        log.info("loaded in %.0fs; %.1f GB of GPU memory in use", time.monotonic() - started,
                 torch.cuda.memory_allocated() / 1e9)

    def ask(self, state: str, questions: dict) -> dict:
        with self.lock, self.torch.inference_mode():
            return jsonable(self.model.system_one(state=state, questions=questions)["answers"])


def make_handler(model):
    class Handler(BaseHTTPRequestHandler):
        server_version = "aicd3-d3/1"

        def send(self, code: int, data: dict) -> None:
            body = json.dumps(data).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.split("?")[0] != "/health":
                return self.send(404, {"error": "not found"})
            self.send(200, {"ok": True, "model": model.name, "revision": model.revision, "device": model.device,
                            "gpu": model.gpu, "loaded_at": model.loaded_at})

        def do_POST(self):
            if self.path.split("?")[0] != "/v1/systemone":
                return self.send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n <= 0 or n > MAX_BODY:
                return self.send(413 if n > MAX_BODY else 400, {"error": f"send a JSON body of at most {MAX_BODY} bytes"})
            try:
                state, questions = check_request(json.loads(self.rfile.read(n).decode("utf-8")))
            except (ValueError, UnicodeDecodeError) as e:
                return self.send(400, {"error": str(e)})
            started = time.monotonic()
            try:
                answers = model.ask(state, questions)
            except Exception as e:   # a bad question shape, out of memory...: report it, keep serving
                log.exception("request failed")
                return self.send(500, {"error": f"{type(e).__name__}: {str(e)[:300]}"})
            self.send(200, {"answers": answers, "ms": round((time.monotonic() - started) * 1000)})

        def log_message(self, fmt, *args):   # one quiet line per request
            log.debug("%s %s", self.address_string(), fmt % args)

    return Handler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=setting("D3_MODEL", DEFAULT_MODEL))
    ap.add_argument("--revision", default=setting("D3_REVISION"), help="model commit to load (pins its code)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(setting("D3_PORT", str(DEFAULT_PORT))))
    ap.add_argument("--allow-remote", action="store_true",
                    help="allow --host other than localhost (there's no sign-in: only on a network you trust)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.allow_remote:
        ap.error("this server has no sign-in, so it only listens on this computer; add --allow-remote to override")

    model = Model(args.model, args.revision or None)
    started = time.monotonic()
    model.ask(SAMPLE, {"fit": {"type": "noul", "instructions": "Is modeling central to this internship?"}})
    log.info("warm-up answer in %.1fs", time.monotonic() - started)

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(model))
    log.info("d3 server ready on http://%s:%d (health: /health)", args.host, args.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
