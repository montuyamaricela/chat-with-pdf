# Margin Research

A local literature review workspace for thesis and capstone projects. Create a research project, discover open-access papers, index their public PDFs, search page-aware passages, ask source-grounded questions, and save an evidence matrix with your own notes.

This started from [Mastra's chat-with-pdf template](https://github.com/mastra-ai/template-chat-with-pdf) at commit [`1aa7bad`](https://github.com/mastra-ai/template-chat-with-pdf/commit/1aa7bad1f1126138a94a82a814e546b1a8613d59). The React research frontend, project and evidence data model, OpenAlex discovery, PostgreSQL storage, and HNSW index were added in this workspace.

## Run locally

Requirements: Node.js 22.13+, pnpm, Docker with Compose, and an OpenAI API key for PDF indexing and content search.

```bash
cp .env.example .env
# Set OPENAI_API_KEY in .env
pnpm install
docker compose up -d db
pnpm dev
```

If you use Colima, start it and run `docker --context colima compose up -d db` for the database step. Open the [research frontend](http://localhost:5173). [Mastra Studio](http://localhost:4111) runs alongside it. Project organization and paper discovery work without an OpenAI key; indexing, retrieval, and grounded answers require one.

## Research workflow

1. **Create a project** with a title and research question.
2. **Discover papers** through OpenAlex or add a public PDF URL manually. Discovery metadata is a starting point; review the record, PDF, and reuse terms before indexing. An `OPENALEX_API_KEY` can be supplied for sustained API use. Re-adding the same PDF URL to a project opens its existing indexed record without another embedding call.
3. **Read and search** indexed papers in the selected project. Ask the library for a concise synthesis or find passages without generating an answer.
4. **Capture evidence** from retrieved passages. The server resolves a saved passage against the indexed vector record, then stores its original paper, page, quote, type, and your note.
5. **Verify citations** by opening the original PDF at the linked page. The AI answer is a research aid, not a substitute for reading or for original student work.

The current importer accepts public PDFs up to 25 MB with extractable text. Scanned PDFs require OCR, which is not implemented. The frontend does not upload local files. Paper discovery uses [OpenAlex work metadata and open-access locations](https://help.openalex.org/api/); its result list may contain records without a working direct PDF link.

## Database configuration

`DATABASE_URL` configures Mastra storage, research projects, papers, evidence, vector search, and the HNSW verification command. The default is the local Compose database:

```dotenv
DATABASE_URL=postgresql://chatpdf:chatpdf@localhost:5433/chat_with_pdf
```

To move to hosted storage, set `DATABASE_URL` to a PostgreSQL database with pgvector available. The code does not need to change. Set `FRONTEND_ORIGIN` to the deployed frontend origin for CORS. When frontend and API have different origins, set `VITE_API_BASE_URL` to the public API origin when building the frontend. The Compose credentials are local development defaults.

## HNSW and scale

The `pdf_sections` vector table uses 1,536-dimensional cosine embeddings and an HNSW index (`m=16`, `ef_construction=64`). Project-scoped retrieval uses pgvector's `ORDER BY embedding <=> query LIMIT k` shape, with `ef_search=100` and iterative scanning, so PostgreSQL can choose the HNSW index. The project and document metadata fields also have PostgreSQL indexes. Run:

```bash
pnpm verify:hnsw
```

This prints PostgreSQL's real `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` definition. The UI also reports when the index is present. PostgreSQL may choose a project metadata index and exact sort for small or selective collections; the presence of HNSW does not prove every query uses it. **Large-corpus latency and recall have not been benchmarked.** A thousand papers can create many more than a thousand vectors; build a representative question set and compare exact versus HNSW retrieval before claiming an observed speedup. HNSW is distinct from document/section hierarchical RAG, which is not implemented. See the [retrieval scalability assessment](docs/rag-research.md).

## Key paths

| Path | Purpose |
| --- | --- |
| `web/` | Research workspace frontend |
| `src/mastra/routes/app-routes.ts` | Project, discovery, paper, search, answer, and evidence routes |
| `src/mastra/lib/research-store.ts` | PostgreSQL research records and source-backed evidence |
| `src/mastra/lib/paper-discovery.ts` | OpenAlex discovery adapter |
| `src/mastra/lib/research-retrieval.ts` | Project-scoped vector search |
| `src/mastra/workflows/index-pdf.ts` | PDF extraction, chunking, embedding, and indexing |
| `src/mastra/lib/vector-store.ts` | pgvector connection and HNSW setup |
| `compose.yaml` | Local PostgreSQL with pgvector |

Run `pnpm typecheck` and `pnpm build` to validate the code. The frontend build goes to `dist-web/`; the Mastra build goes to `.mastra/output/`.

## Scope before public deployment

This is a local portfolio project. A public multi-user service would need authentication, per-user access control, PDF URL download protection, background indexing jobs, rate limits, and more robust paper metadata and citation validation. The evidence matrix stores verified source passages and student notes; it does not automatically determine whether a study is credible or whether a research gap exists.
