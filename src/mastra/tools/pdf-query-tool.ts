import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { vectorStore, PDF_INDEX_NAME, ensureVectorIndex } from '../lib/vector-store';

export const pdfQueryTool = createTool({
  id: 'query-pdf-content',
  description: `Search indexed PDF content by meaning. Optionally restrict the search to a document and a page range.
For corpus-wide questions, omit documentId. For page-range questions, provide both pageStart and pageEnd.`,
  inputSchema: z.object({
    queryText: z.string().min(1).describe('Semantic search query describing the content to find'),
    documentId: z.string().optional().describe('Restrict results to a document ID from list-documents'),
    pageStart: z.number().int().min(1).optional().describe('First page in the range, inclusive'),
    pageEnd: z.number().int().min(1).optional().describe('Last page in the range, inclusive'),
  }),
  execute: async ({ queryText, documentId, pageStart, pageEnd }) => {
    if ((pageStart === undefined) !== (pageEnd === undefined)) {
      throw new Error('Provide both pageStart and pageEnd to search a page range.');
    }
    if (pageStart !== undefined && pageEnd !== undefined && pageStart > pageEnd) {
      throw new Error('pageStart must be less than or equal to pageEnd.');
    }

    const embeddingModel = new ModelRouterEmbeddingModel('openai/text-embedding-3-small');
    const { embeddings } = await embeddingModel.doEmbed({ values: [queryText] });
    await ensureVectorIndex();

    const filter = {
      ...(documentId ? { documentId } : {}),
      ...(pageStart !== undefined && pageEnd !== undefined
        ? { pageNumber: { $gte: pageStart, $lte: pageEnd } }
        : {}),
    };

    const results = await vectorStore.query({
      indexName: PDF_INDEX_NAME,
      queryVector: embeddings[0],
      topK: 20,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      ef: 80,
    });

    return {
      chunks: results.map(result => ({
        text: String(result.metadata?.text ?? ''),
        documentId: result.metadata?.documentId,
        documentTitle: result.metadata?.documentTitle,
        url: result.metadata?.url,
        pageNumber: result.metadata?.pageNumber,
        score: result.score,
      })),
      totalChunks: results.length,
      pageRange: pageStart !== undefined ? { start: pageStart, end: pageEnd } : undefined,
    };
  },
});
