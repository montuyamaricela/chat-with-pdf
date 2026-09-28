import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { ensureVectorIndex, vectorStore } from './vector-store';

export type ResearchHit = {
  vectorId: string;
  documentId: string;
  title: string;
  url: string;
  pageNumber: number;
  text: string;
  score: number;
};

type HitRow = {
  vector_id: string;
  metadata: {
    documentId?: string;
    documentTitle?: string;
    url?: string;
    pageNumber?: number;
    text?: string;
  };
  score: number;
};

export async function searchResearch(input: {
  projectId: string;
  query: string;
  documentId?: string;
  limit?: number;
}): Promise<ResearchHit[]> {
  await ensureVectorIndex();
  const model = new ModelRouterEmbeddingModel('openai/text-embedding-3-small');
  const { embeddings } = await model.doEmbed({ values: [input.query] });
  const vector = `[${embeddings[0].join(',')}]`;
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const client = await vectorStore.pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL hnsw.ef_search = 100');
    await client.query('SET LOCAL hnsw.iterative_scan = strict_order');
    const result = await client.query<HitRow>(
      `SELECT vector_id, metadata, 1 - (embedding <=> $1::vector) AS score
         FROM pdf_sections
        WHERE namespace = 'default'
          AND metadata->>'projectId' = $2
          ${input.documentId ? "AND metadata->>'documentId' = $3" : ''}
        ORDER BY embedding <=> $1::vector
        LIMIT $${input.documentId ? 4 : 3}`,
      input.documentId
        ? [vector, input.projectId, input.documentId, limit]
        : [vector, input.projectId, limit],
    );
    await client.query('COMMIT');
    return result.rows.map(row => ({
      vectorId: row.vector_id,
      documentId: String(row.metadata?.documentId ?? ''),
      title: String(row.metadata?.documentTitle ?? 'Untitled paper'),
      url: String(row.metadata?.url ?? ''),
      pageNumber: Number(row.metadata?.pageNumber ?? 0),
      text: String(row.metadata?.text ?? ''),
      score: Number(row.score),
    })).filter(hit => hit.documentId && hit.pageNumber > 0 && hit.text);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
