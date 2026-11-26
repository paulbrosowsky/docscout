# Docscout

Search your own documents by meaning, fully on your machine.

Point Docscout at a folder of **PDF, Markdown and Word (.docx)** files. It indexes
them locally, shows the folder as an explorer-style file tree, previews any file in
the browser, and finds the documents that match what you describe, even when they
use different words.

Nothing leaves your computer: the database, the embedding model and the language
model all run in Docker on the same machine.

## Quick start

Requirements: Docker with Compose, about 4 GB of free RAM and 3 GB of disk.

```bash
cp .env.example .env
# Edit DOCS_DIR in .env: the folder Docscout may read (mounted read-only).
docker compose up -d --build
```

Open <http://localhost:8080>.

The first start downloads two models: the embedding model (about 470 MB, on the
first index) and the default summary model `qwen2.5:1.5b` (about 1 GB, by the
`ollama-pull` service). Search works before the summary model is ready.
Docscout then uses the opening sentences of each file as its summary.

Without a `.env`, the bundled `sample-docs/` folder is mounted, so you can try it
right away.

### Using it from another machine (SSH tunnel)

The web UI only listens on `127.0.0.1`. To use Docscout running on a server:

```bash
ssh -N -L 8080:localhost:8080 you@your-server
```

Then open <http://localhost:8080> on your own machine.

## How to use it

1. **Create a project.** Give it a name and a description. Under *Index settings*
   you can change the chunk size and overlap. The defaults come from `.env`.
2. **Add the main directory.** Pick a folder below `DOCS_DIR`. When you press
   *Create and index*, Docscout scans the folder and indexes every supported file
   straight away. The header shows the progress.
3. **Browse.** The left pane shows the folder as a file tree. Click a file to open
   it in the preview.
4. **Search.** Describe what you are looking for in the text box and press Enter.
   Each result shows the title, a short summary, the passage that matched and the
   path. Click the title or the path to open the file in the preview (PDFs open at
   the matching page). The file tree collapses to make room. The button next to
   the file count brings it back.

The model dropdown in the search box decides how result summaries are written:

* **Fast (no AI)** shows each file's stored summary, written once while indexing.
* **A model name** asks that model to explain, for your query, what each result
  contains that is relevant. It is slower (a few seconds per result on a CPU) but
  more useful.

Projects rescan for changed files whenever you open them, and when you press the
refresh button above the tree.

### Settings

* **Project settings** (header): rename, change the directory, change the chunk
  size and overlap (re-indexes the project), rescan, full re-index, delete. Deleting
  a project never touches your files.
* **Models** (header):
  * *Model*: turn AI summaries on or off and choose the default model.
  * *Parameters*: temperature, top P, context window (`num_ctx`), max output tokens
    (`num_predict`), and how much document text each summary sees.
  * *Prompts*: edit the file-summary and search-result prompts.
  * *Library*: see installed models, download new ones by name, or remove them.

## Model choices

| Role | Default | Why |
| --- | --- | --- |
| Embeddings | `intfloat/multilingual-e5-small` (384 dims) | Small (118M parameters), quick on a CPU through ONNX Runtime with no PyTorch or GPU needed, and strong at retrieval in about 100 languages, so German and English documents can be searched in either language. |
| Summaries | `qwen2.5:1.5b` via Ollama | About 1 GB quantised, writes clean short summaries in the document's language, and runs at a usable speed on a laptop CPU. |

Other small models that work well on a CPU are listed in the Models dialog and can
be downloaded from there: `qwen3:1.7b`, `qwen2.5:0.5b` (fastest), `qwen2.5:3b`
(better, slower), `LiquidAI/lfm2.5-1.2b-instruct` and `gemma3:1b`. Any other
Ollama model name works too.

The embedding model is set in `.env` (`EMBEDDING_MODEL`, `EMBEDDING_DIM`), because
changing it invalidates every stored vector. Docscout notices the change on start
and re-indexes. Built-in fastembed models such as
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384) or
`intfloat/multilingual-e5-large` (1024) also work.

## How it works

```
browser ──► app (FastAPI + built React UI) ──► Postgres + pgvector
                    │                            (projects, files, chunks, vectors)
                    ├──► fastembed (ONNX, in-process): embeddings
                    └──► Ollama: summaries
```

* **Indexing** walks the folder, extracts text (`pypdf` per page, `python-docx`
  including tables, Markdown as is), splits it into overlapping, paragraph-aware
  chunks, embeds them and stores them in pgvector with an HNSW index. File
  summaries are written afterwards, so a project is searchable before the slow
  part finishes. Rescans only touch new or changed files.
* **Search** is hybrid: vector similarity (cosine) and Postgres full-text search
  are merged with reciprocal rank fusion, then grouped per file. Meaning-based
  matches and exact terms such as names or invoice numbers both rank well.
* **Preview**: PDFs use the browser's viewer. Markdown is rendered with
  `react-markdown`. DOCX is converted to HTML with `mammoth` and sanitised with
  DOMPurify.
* **Safety**: the documents folder is mounted read-only. Every file path is
  resolved and checked to stay inside it.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCS_DIR` | `./sample-docs` | Host folder Docscout may read |
| `PORT` | `8080` | Port on localhost |
| `SUMMARY_MODEL` | `qwen2.5:1.5b` | Default Ollama model, pulled on start |
| `EMBEDDING_MODEL` | `intfloat/multilingual-e5-small` | fastembed model name |
| `EMBEDDING_DIM` | `384` | Its vector size |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `150` | Defaults for new projects |

## Development

```bash
# Database
docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_USER=docscout -e POSTGRES_PASSWORD=docscout \
  -e POSTGRES_DB=docscout pgvector/pgvector:pg17

# Backend
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
DOCS_ROOT=$PWD/.. .venv/bin/uvicorn app.main:app --reload   # http://localhost:8000
.venv/bin/python -m pytest                                  # uses a stub embedder, no downloads

# Frontend (proxies /api to :8000)
cd frontend
npm install
npm run dev
```

The UI uses [shadcn/ui](https://ui.shadcn.com) with the **Rhea** style on Base UI
(`components.json` style `base-rhea`). The file tree follows shadcn's
[AI Elements File Tree](https://ui.shadcn.com/docs/ai-elements/base/file-tree)
(Collapsible folders, ghost Button files). Add more components with
`npx shadcn@latest add <name>`.
