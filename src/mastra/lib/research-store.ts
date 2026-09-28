import { randomUUID } from 'node:crypto';
import { vectorStore } from './vector-store';

export const DEFAULT_PROJECT_ID = 'default';

export type PaperInput = {
  documentId: string;
  projectId: string;
  url: string;
  title: string;
  authors: string[];
  publicationYear?: number;
  doi?: string;
  openalexId?: string;
  totalPages: number;
  totalChunks: number;
};

let initialization: Promise<void> | undefined;

export function ensureResearchSchema(): Promise<void> {
  initialization ??= initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

async function initialize(): Promise<void> {
  const db = vectorStore.pool;
  await db.query(`CREATE TABLE IF NOT EXISTS research_projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    research_question TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`INSERT INTO research_projects (project_id, title, research_question)
    VALUES ($1, 'My research project', '') ON CONFLICT (project_id) DO NOTHING`, [DEFAULT_PROJECT_ID]);
  await db.query(`CREATE TABLE IF NOT EXISTS pdf_documents (
    document_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    total_pages INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`ALTER TABLE pdf_documents ADD COLUMN IF NOT EXISTS project_id TEXT`);
  await db.query(`ALTER TABLE pdf_documents ADD COLUMN IF NOT EXISTS authors TEXT[] NOT NULL DEFAULT '{}'`);
  await db.query(`ALTER TABLE pdf_documents ADD COLUMN IF NOT EXISTS publication_year INTEGER`);
  await db.query(`ALTER TABLE pdf_documents ADD COLUMN IF NOT EXISTS doi TEXT`);
  await db.query(`ALTER TABLE pdf_documents ADD COLUMN IF NOT EXISTS openalex_id TEXT`);
  await db.query(`UPDATE pdf_documents SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
  await db.query(`ALTER TABLE pdf_documents ALTER COLUMN project_id SET NOT NULL`);
  await db.query(`ALTER TABLE pdf_documents DROP CONSTRAINT IF EXISTS pdf_documents_url_key`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS pdf_documents_project_url_idx
    ON pdf_documents (project_id, url)`);
  await db.query(`CREATE INDEX IF NOT EXISTS pdf_documents_project_cursor_idx
    ON pdf_documents (project_id, document_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS research_evidence (
    evidence_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES research_projects(project_id),
    document_id TEXT NOT NULL REFERENCES pdf_documents(document_id) ON DELETE CASCADE,
    vector_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('finding', 'method', 'limitation', 'context')),
    quote TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, vector_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS research_evidence_project_idx
    ON research_evidence (project_id, created_at DESC)`);
}

export async function listProjects() {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query<{
    project_id: string; title: string; research_question: string; created_at: Date;
    paper_count: string; evidence_count: string;
  }>(`SELECT p.project_id, p.title, p.research_question, p.created_at,
      (SELECT count(*) FROM pdf_documents d WHERE d.project_id = p.project_id) AS paper_count,
      (SELECT count(*) FROM research_evidence e WHERE e.project_id = p.project_id) AS evidence_count
    FROM research_projects p ORDER BY p.created_at ASC`);
  return result.rows.map(row => ({
    projectId: row.project_id,
    title: row.title,
    researchQuestion: row.research_question,
    createdAt: row.created_at.toISOString(),
    paperCount: Number(row.paper_count),
    evidenceCount: Number(row.evidence_count),
  }));
}

export async function createProject(title: string, researchQuestion: string) {
  await ensureResearchSchema();
  const projectId = randomUUID();
  const result = await vectorStore.pool.query<{ created_at: Date }>(
    `INSERT INTO research_projects (project_id, title, research_question)
      VALUES ($1, $2, $3) RETURNING created_at`,
    [projectId, title, researchQuestion],
  );
  return { projectId, title, researchQuestion, createdAt: result.rows[0].created_at.toISOString(), paperCount: 0, evidenceCount: 0 };
}

export async function getProject(projectId: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query<{ project_id: string; title: string; research_question: string }>(
    `SELECT project_id, title, research_question FROM research_projects WHERE project_id = $1`, [projectId],
  );
  const row = result.rows[0];
  return row ? { projectId: row.project_id, title: row.title, researchQuestion: row.research_question } : undefined;
}

export async function updateProject(projectId: string, title: string, researchQuestion: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query(
    `UPDATE research_projects SET title = $2, research_question = $3 WHERE project_id = $1`,
    [projectId, title, researchQuestion],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function recordPaper(paper: PaperInput): Promise<void> {
  await ensureResearchSchema();
  await vectorStore.pool.query(
    `INSERT INTO pdf_documents
      (document_id, project_id, url, title, authors, publication_year, doi, openalex_id,
       total_pages, total_chunks, indexed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (document_id) DO UPDATE SET
        title = EXCLUDED.title, authors = EXCLUDED.authors,
        publication_year = EXCLUDED.publication_year, doi = EXCLUDED.doi,
        openalex_id = EXCLUDED.openalex_id, total_pages = EXCLUDED.total_pages,
        total_chunks = EXCLUDED.total_chunks, indexed_at = now()`,
    [paper.documentId, paper.projectId, paper.url, paper.title, paper.authors,
      paper.publicationYear ?? null, paper.doi ?? null, paper.openalexId ?? null,
      paper.totalPages, paper.totalChunks],
  );
}

type PaperRow = {
  document_id: string; project_id: string; url: string; title: string; authors: string[];
  publication_year: number | null; doi: string | null; openalex_id: string | null;
  total_pages: number; total_chunks: number; indexed_at: Date;
};

function mapPaper(row: PaperRow) {
  return {
    documentId: row.document_id, projectId: row.project_id, url: row.url,
    title: row.title, authors: row.authors, publicationYear: row.publication_year,
    doi: row.doi, openalexId: row.openalex_id, totalPages: row.total_pages,
    totalChunks: row.total_chunks, indexedAt: row.indexed_at.toISOString(),
  };
}

export async function listPapers(projectId: string, limit = 50, after?: string, search?: string) {
  await ensureResearchSchema();
  const term = search?.trim() ?? '';
  const result = await vectorStore.pool.query<PaperRow>(
    `SELECT document_id, project_id, url, title, authors, publication_year, doi,
        openalex_id, total_pages, total_chunks, indexed_at
      FROM pdf_documents
      WHERE project_id = $1 AND document_id > $2
        AND ($3 = '' OR title ILIKE '%' || $3 || '%'
          OR array_to_string(authors, ' ') ILIKE '%' || $3 || '%'
          OR doi ILIKE '%' || $3 || '%')
      ORDER BY document_id LIMIT $4`,
    [projectId, after ?? '', term, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const papers = result.rows.slice(0, limit).map(mapPaper);
  return { papers, nextCursor: hasMore ? papers.at(-1)?.documentId : undefined };
}

export async function getPaper(documentId: string, projectId?: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query<PaperRow>(
    `SELECT document_id, project_id, url, title, authors, publication_year, doi,
        openalex_id, total_pages, total_chunks, indexed_at
      FROM pdf_documents WHERE document_id = $1 AND ($2::text IS NULL OR project_id = $2)`,
    [documentId, projectId ?? null],
  );
  return result.rows[0] ? mapPaper(result.rows[0]) : undefined;
}

export async function getPaperByUrl(projectId: string, url: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query<PaperRow>(
    `SELECT document_id, project_id, url, title, authors, publication_year, doi,
        openalex_id, total_pages, total_chunks, indexed_at
      FROM pdf_documents WHERE project_id = $1 AND url = $2`,
    [projectId, url],
  );
  return result.rows[0] ? mapPaper(result.rows[0]) : undefined;
}

export async function listEvidence(projectId: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query<{
    evidence_id: string; document_id: string; vector_id: string; kind: string;
    quote: string; page_number: number; note: string; created_at: Date;
    title: string; url: string; authors: string[]; publication_year: number | null;
  }>(`SELECT e.evidence_id, e.document_id, e.vector_id, e.kind, e.quote,
      e.page_number, e.note, e.created_at, d.title, d.url, d.authors, d.publication_year
    FROM research_evidence e JOIN pdf_documents d ON d.document_id = e.document_id
    WHERE e.project_id = $1 ORDER BY e.created_at DESC`, [projectId]);
  return result.rows.map(row => ({
    evidenceId: row.evidence_id, documentId: row.document_id, vectorId: row.vector_id,
    kind: row.kind, quote: row.quote, pageNumber: row.page_number, note: row.note,
    createdAt: row.created_at.toISOString(), title: row.title, url: row.url,
    authors: row.authors, publicationYear: row.publication_year,
  }));
}

export async function saveEvidence(input: {
  projectId: string; documentId: string; vectorId: string;
  kind: 'finding' | 'method' | 'limitation' | 'context'; note: string;
}) {
  await ensureResearchSchema();
  const paper = await getPaper(input.documentId, input.projectId);
  if (!paper) return undefined;
  const source = await vectorStore.pool.query<{ metadata: { text?: string; pageNumber?: number } }>(
    `SELECT metadata FROM pdf_sections
      WHERE vector_id = $1 AND metadata->>'documentId' = $2
        AND COALESCE(metadata->>'projectId', 'default') = $3 LIMIT 1`,
    [input.vectorId, input.documentId, input.projectId],
  );
  const metadata = source.rows[0]?.metadata;
  if (!metadata?.text || !Number.isInteger(metadata.pageNumber)) return undefined;
  const evidenceId = randomUUID();
  await vectorStore.pool.query(
    `INSERT INTO research_evidence
      (evidence_id, project_id, document_id, vector_id, kind, quote, page_number, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, vector_id) DO UPDATE SET
        kind = EXCLUDED.kind, note = EXCLUDED.note, quote = EXCLUDED.quote,
        page_number = EXCLUDED.page_number`,
    [evidenceId, input.projectId, input.documentId, input.vectorId,
      input.kind, metadata.text, metadata.pageNumber, input.note],
  );
  return true;
}

export async function deleteEvidence(projectId: string, evidenceId: string) {
  await ensureResearchSchema();
  const result = await vectorStore.pool.query(
    `DELETE FROM research_evidence WHERE project_id = $1 AND evidence_id = $2`,
    [projectId, evidenceId],
  );
  return (result.rowCount ?? 0) > 0;
}
