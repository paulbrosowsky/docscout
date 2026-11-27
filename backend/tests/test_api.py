import time

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def project(client):
    r = client.post("/api/projects", json={"name": "Test", "description": "Samples", "root_path": "sample-docs"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    for _ in range(100):
        status = client.get(f"/api/projects/{pid}/status").json()
        if status["state"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert status["state"] == "done", status
    yield pid
    client.delete(f"/api/projects/{pid}")


def test_browse_dirs(client):
    r = client.get("/api/fs/dirs", params={"path": "sample-docs"})
    assert r.status_code == 200
    assert {d["name"] for d in r.json()["dirs"]} == {"contracts", "manuals", "notes"}
    assert r.json()["parent"] == ""


def test_browse_rejects_escape(client):
    assert client.get("/api/fs/dirs", params={"path": "../.."}).status_code == 400


def test_tree_is_nested(client, project):
    tree = client.get(f"/api/projects/{project}/tree").json()
    assert [n["name"] for n in tree] == ["contracts", "manuals", "notes", "Sales-Report-Q3.docx"]
    notes = next(n for n in tree if n["name"] == "notes")
    assert [c["name"] for c in notes["children"]] == ["meetings", "Onboarding-Checkliste.docx", "recipes.md"]


def test_search_finds_relevant_file(client, project):
    r = client.post(f"/api/projects/{project}/search", json={"query": "Wie hoch ist die Kaltmiete?"})
    results = r.json()["results"]
    assert results[0]["path"] == "contracts/Mietvertrag-Wohnung-Berlin.pdf"
    assert results[0]["page"] == 2
    assert "Kaltmiete" in results[0]["snippet"]
    assert results[0]["title"] == "Mietvertrag Wohnung Berlin"
    assert results[0]["summary"]


def test_search_descaling(client, project):
    results = client.post(f"/api/projects/{project}/search", json={"query": "how often to descale the espresso machine"}).json()["results"]
    assert results[0]["path"] == "manuals/Espresso-Machine-Manual.pdf"


def test_previews(client, project):
    md = client.get(f"/api/projects/{project}/preview", params={"path": "notes/recipes.md"}).json()
    assert md["kind"] == "markdown" and "Apple pie" in md["content"]
    dx = client.get(f"/api/projects/{project}/preview", params={"path": "Sales-Report-Q3.docx"}).json()
    assert dx["kind"] == "html" and "<table>" in dx["content"]
    pdf = client.get(f"/api/projects/{project}/raw", params={"path": "manuals/Espresso-Machine-Manual.pdf"})
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("inline")


def test_raw_rejects_traversal(client, project):
    r = client.get(f"/api/projects/{project}/raw", params={"path": "../backend/app/main.py"})
    assert r.status_code == 404


def test_rescan_is_incremental(client, project):
    client.post(f"/api/projects/{project}/scan")
    for _ in range(100):
        status = client.get(f"/api/projects/{project}/status").json()
        if status["state"] == "done":
            break
        time.sleep(0.1)
    assert status["to_index"] == 0 and status["total"] == 6


def _wait(client, pid):
    for _ in range(100):
        status = client.get(f"/api/projects/{pid}/status").json()
        if status["state"] in ("done", "error", "idle"):
            return status
        time.sleep(0.1)
    return status


def test_project_defaults_and_chunk_change_reindexes(client, scratch_docs):
    r = client.post("/api/projects", json={"name": "Chunks", "root_path": scratch_docs})
    p = r.json()
    assert p["chunk_size"] == 1000 and p["chunk_overlap"] == 150
    assert _wait(client, p["id"])["indexed"] == 3
    r = client.patch(f"/api/projects/{p['id']}", json={"chunk_size": 300, "chunk_overlap": 50})
    assert r.status_code == 200 and r.json()["chunk_size"] == 300
    status = _wait(client, p["id"])
    assert status["state"] == "done" and status["to_index"] == 3
    client.delete(f"/api/projects/{p['id']}")


def test_invalid_chunk_overlap_rejected(client):
    r = client.post("/api/projects", json={"name": "Bad", "chunk_size": 400, "chunk_overlap": 300})
    assert r.status_code == 400


def test_llm_settings_roundtrip(client):
    original = client.get("/api/settings/llm").json()
    changed = {**original, "temperature": 0.7, "num_ctx": 8192}
    assert client.put("/api/settings/llm", json=changed).json()["temperature"] == 0.7
    assert client.get("/api/settings/llm").json()["num_ctx"] == 8192
    client.put("/api/settings/llm", json=original)
    assert client.put("/api/settings/llm", json={**original, "temperature": 5}).status_code == 422


def test_models_without_ollama(client):
    body = client.get("/api/models").json()
    assert body["ollama_available"] is False and body["suggested"]


def test_overlapping_project_folders_are_rejected(client, project):
    for root in ("sample-docs", "sample-docs/notes", "", "sample-docs/notes/meetings"):
        r = client.post("/api/projects", json={"name": "Overlap", "root_path": root})
        assert r.status_code == 409, root
        assert "must not overlap" in r.json()["detail"]
    # Path tricks resolve to the same folder.
    r = client.post("/api/projects", json={"name": "Overlap", "root_path": "backend/../sample-docs/"})
    assert r.status_code == 409


def test_sibling_folder_is_allowed_and_project_can_keep_its_own_root(client, project, scratch_docs):
    r = client.post("/api/projects", json={"name": "Sibling", "root_path": scratch_docs})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    _wait(client, pid)
    # Saving its own root again is not a conflict, moving into the other project's folder is.
    assert client.patch(f"/api/projects/{pid}", json={"root_path": scratch_docs}).status_code == 200
    assert client.patch(f"/api/projects/{pid}", json={"root_path": "sample-docs/manuals"}).status_code == 409
    client.delete(f"/api/projects/{pid}")


def test_directory_browser_marks_taken_folders(client, project):
    top = client.get("/api/fs/dirs").json()
    sample = next(d for d in top["dirs"] if d["name"] == "sample-docs")
    assert sample["taken_by"]["id"] == project and sample["available"] is False
    assert top["available"] is False  # the docs root contains a project
    backend = next(d for d in top["dirs"] if d["name"] == "backend")
    assert backend["available"] is True and backend["taken_by"] is None
    inner = client.get("/api/fs/dirs", params={"path": "sample-docs/notes"}).json()
    assert inner["taken_by"]["id"] == project
    # Editing the project itself: its own folder is available.
    own = client.get("/api/fs/dirs", params={"project_id": project}).json()
    assert next(d for d in own["dirs"] if d["name"] == "sample-docs")["available"] is True
