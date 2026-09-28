import { PgVector } from '@mastra/pg';

export const databaseUrl = process.env.DATABASE_URL ??
  'postgresql://chatpdf:chatpdf@localhost:5433/chat_with_pdf';

export const vectorStore = new PgVector({
  id: 'pdf-vectors',
  connectionString: databaseUrl,
});

export const PDF_INDEX_NAME = 'pdf_sections';

let indexInitialization: Promise<void> | undefined;

export function ensureVectorIndex(): Promise<void> {
  indexInitialization ??= vectorStore.createIndex({
    indexName: PDF_INDEX_NAME,
    dimension: 1536,
    metric: 'cosine',
    indexConfig: { type: 'hnsw', hnsw: { m: 16, efConstruction: 64 } },
    metadataIndexes: ['projectId', 'documentId', 'pageNumber'],
  }).then(async () => {
    await vectorStore.pool.query(`UPDATE pdf_sections
      SET metadata = jsonb_set(metadata, '{projectId}', '"default"'::jsonb)
      WHERE metadata ? 'documentId' AND NOT metadata ? 'projectId'`);
    await vectorStore.pool.query(`CREATE INDEX IF NOT EXISTS pdf_sections_project_id_idx
      ON pdf_sections ((metadata->>'projectId'))`);
  }).catch(error => {
    indexInitialization = undefined;
    throw error;
  });
  return indexInitialization;
}
