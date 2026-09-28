import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listDocuments } from '../lib/document-registry';

export const listDocumentsTool = createTool({
  id: 'list-documents',
  description: `List indexed PDF documents, one page at a time.
Use this tool when:
- The user asks what documents/books are available
- You need to know which documents exist before quizzing
  - Pass nextCursor as after to see the next page when there are more documents.`,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    after: z.string().optional().describe('Cursor from the previous page'),
  }),
  execute: async ({ limit, after }) => {
    const result = await listDocuments(limit, after);
    return {
      ...result,
      count: result.documents.length,
      message: result.documents.length === 0 && !after
        ? 'No documents have been indexed yet. Use the index-pdf workflow to add a PDF.'
        : undefined,
    };
  },
});
