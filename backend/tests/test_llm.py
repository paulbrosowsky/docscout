"""LLM paths against a fake Ollama server."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.summarizer import get_summarizer

PROMPTS: list[dict] = []


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send({"models": [{"name": "tiny:1b", "size": 1, "details": {"parameter_size": "1B"}}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        PROMPTS.append(body)
        self._send({"response": f"<think>x</think>Summary by {body['model']}."})


@pytest.fixture(scope="module")
def client():
    server = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with TestClient(app) as c:
        s = get_summarizer()
        old_client = s._client
        s._client = httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}")
        s._models = None
        original = c.get("/api/settings/llm").json()
        c.put("/api/settings/llm", json={**original, "enabled": True, "model": "tiny:1b", "temperature": 0.5})
        yield c
        c.put("/api/settings/llm", json=original)
        s._client = old_client
        s._models = None
    server.shutdown()


def test_indexing_writes_llm_summaries(client):
    pid = client.post("/api/projects", json={"name": "LLM", "root_path": "sample-docs/manuals"}).json()["id"]
    for _ in range(100):
        status = client.get(f"/api/projects/{pid}/status").json()
        if status["state"] == "done":
            break
        time.sleep(0.1)
    assert status["summarized"] == 1
    info = client.get(f"/api/projects/{pid}/file", params={"path": "Espresso-Machine-Manual.pdf"}).json()
    assert info["summary"] == "Summary by tiny:1b." and info["summary_source"] == "llm"
    assert PROMPTS[-1]["options"]["temperature"] == 0.5

    r = client.post(
        f"/api/projects/{pid}/summarize",
        json={"path": "Espresso-Machine-Manual.pdf", "query": "descaling", "model": "tiny:1b"},
    )
    assert r.json()["summary"] == "Summary by tiny:1b."
    assert "Query: descaling" in PROMPTS[-1]["prompt"]

    missing = client.post(
        f"/api/projects/{pid}/summarize",
        json={"path": "Espresso-Machine-Manual.pdf", "query": "x", "model": "nope"},
    )
    assert missing.status_code == 409
    assert client.get("/api/models").json()["models"][0]["name"] == "tiny:1b"
    client.delete(f"/api/projects/{pid}")
