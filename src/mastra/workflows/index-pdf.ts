import { createStep, createWorkflow } from '@mastra/core/workflows';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { MDocument } from '@mastra/rag';
import { z } from 'zod';
import { PDFParse } from 'pdf-parse';
import { createHash } from 'node:crypto';
import { vectorStore, PDF_INDEX_NAME, ensureVectorIndex } from '../lib/vector-store';
import { recordDocument } from '../lib/document-registry';
import { DEFAULT_PROJECT_ID } from '../lib/research-store';

const sourceInputSchema = z.object({
  url: z.url().describe('Public URL of the PDF to ingest'),
  projectId: z.string().min(1).default(DEFAULT_PROJECT_ID),
  titleOverride: z.string().optional(),
  authors: z.array(z.string()).default([]),
  publicationYear: z.number().int().optional(),
  doi: z.string().optional(),
  openalexId: z.string().optional(),
});

const paperFields = {
  projectId: z.string(),
  documentId: z.string(),
  title: z.string(),
  url: z.string(),
  authors: z.array(z.string()),
  publicationYear: z.number().int().optional(),
  doi: z.string().optional(),
  openalexId: z.string().optional(),
  totalPages: z.number(),
};

/**
 * Step 1: Download PDF and extract text from each page
 */
const downloadAndExtractText = createStep({
  id: 'download-and-extract-text',
  description: 'Download PDF from URL and extract text page by page',
  inputSchema: sourceInputSchema,
  outputSchema: z.object({
    ...paperFields,
    pages: z.array(
      z.object({
        pageNumber: z.number(),
        content: z.string(),
      }),
    ),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const { url, projectId, titleOverride, authors, publicationYear, doi, openalexId } = inputData;

    // Fetch PDF
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }

    const MAX_PDF_BYTES = 25 * 1024 * 1024;
    const declaredBytes = Number(response.headers.get('content-length') ?? 0);
    if (declaredBytes > MAX_PDF_BYTES) throw new Error('PDF is larger than the 25 MB local limit.');
    if (!response.body) throw new Error('PDF response has no content.');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_PDF_BYTES) throw new Error('PDF is larger than the 25 MB local limit.');
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = Buffer.concat(parts);
    if (!data.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
      throw new Error('The URL did not return a PDF file.');
    }

    // Extract text using pdf-parse
    const parser = new PDFParse({ data });
    try {
      const info = await parser.getInfo();
      const totalPages = info.total;

      // Preserve the source page of each passage for citation.
      const pages: { pageNumber: number; content: string }[] = [];
      for (let i = 1; i <= totalPages; i++) {
        const result = await parser.getText({ partial: [i] });
        if (result.text.trim()) pages.push({ pageNumber: i, content: result.text });
      }
      if (pages.length === 0) throw new Error('No extractable text was found. Scanned PDFs need OCR.');

      const title = titleOverride?.trim() || info.info?.Title || extractTitleFromUrl(url);
      return {
        projectId,
        documentId: generateDocumentId(projectId, url),
        title: String(title).slice(0, 300),
        url,
        authors,
        publicationYear,
        doi,
        openalexId,
        totalPages,
        pages,
      };
    } finally {
      await parser.destroy();
    }
  },
});

/**
 * Step 2: Split pages into smaller chunks for embedding
 */
const splitIntoChunks = createStep({
  id: 'split-into-chunks',
  description: 'Split page text into smaller overlapping chunks',
  inputSchema: z.object({
    ...paperFields,
    pages: z.array(z.object({ pageNumber: z.number(), content: z.string() })),
  }),
  outputSchema: z.object({
    ...paperFields,
    chunks: z.array(
      z.object({
        text: z.string(),
        metadata: z.record(z.string(), z.any()),
      }),
    ),
  }),
  execute: async ({ inputData: { projectId, documentId, title, url, authors, publicationYear, doi, openalexId, totalPages, pages } }) => {
    const allChunks: { text: string; metadata: Record<string, any> }[] = [];

    for (const page of pages) {
      // Create MDocument from page content
      const doc = MDocument.fromText(page.content, {
        documentId,
        pageNumber: page.pageNumber,
      });

      // Chunk using recursive strategy
      const chunks = await doc.chunk({
        strategy: 'recursive',
        maxSize: 512,
        overlap: 50,
      });

      // Add chunks with metadata
      for (const chunk of chunks) {
        allChunks.push({
          text: String(chunk.text),
          metadata: {
            projectId,
            documentId,
            documentTitle: title,
            url,
            publicationYear,
            doi,
            pageNumber: page.pageNumber,
            totalPages,
          },
        });
      }
    }

    return {
      projectId,
      documentId,
      title,
      url,
      authors,
      publicationYear,
      doi,
      openalexId,
      totalPages,
      chunks: allChunks,
    };
  },
});

/**
 * Step 3: Generate embeddings and store in vector database
 */
const generateAndStoreEmbeddings = createStep({
  id: 'generate-and-store-embeddings',
  description: 'Generate embeddings for each chunk and store in vector database',
  inputSchema: z.object({
    ...paperFields,
    chunks: z.array(
      z.object({
        text: z.string(),
        metadata: z.record(z.string(), z.any()),
      }),
    ),
  }),
  outputSchema: z.object({
    projectId: z.string(),
    documentId: z.string(),
    title: z.string(),
    totalPages: z.number(),
    totalChunks: z.number(),
  }),
  execute: async ({ inputData: { projectId, documentId, title, url, authors, publicationYear, doi, openalexId, totalPages, chunks } }) => {
    // Initialize vector index if needed
    await ensureVectorIndex();

    // Generate embeddings using Mastra's model router
    // Batch to stay under OpenAI's 2048 values per call limit
    const embeddingModel = new ModelRouterEmbeddingModel('openai/text-embedding-3-small');
    const texts = chunks.map(c => c.text);
    const BATCH_SIZE = 2000;
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const result = await embeddingModel.doEmbed({
        values: batch,
      });
      embeddings.push(...result.embeddings);
    }

    // Prepare metadata for storage
    const metadata = chunks.map(c => ({
      text: c.text,
      ...c.metadata,
    }));

    // Replace this document's vectors as part of the upsert operation.
    await vectorStore.upsert({
      indexName: PDF_INDEX_NAME,
      vectors: embeddings,
      metadata,
      deleteFilter: { documentId },
    });

    await recordDocument({
      projectId, documentId, url, title, authors, publicationYear, doi, openalexId,
      totalPages, totalChunks: chunks.length,
    });

    return {
      projectId,
      documentId,
      title,
      totalPages,
      totalChunks: chunks.length,
    };
  },
});

// Create the workflow
const indexPdfWorkflow = createWorkflow({
  id: 'index-pdf',
  inputSchema: sourceInputSchema,
  outputSchema: z.object({
    projectId: z.string(),
    documentId: z.string(),
    title: z.string(),
    totalPages: z.number(),
    totalChunks: z.number(),
  }),
})
  .then(downloadAndExtractText)
  .then(splitIntoChunks)
  .then(generateAndStoreEmbeddings);

indexPdfWorkflow.commit();

export { indexPdfWorkflow };

// Helper functions
function extractTitleFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() || 'document';
    return filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
  } catch {
    return 'Untitled PDF';
  }
}

function generateDocumentId(projectId: string, url: string): string {
  return `pdf-${createHash('sha256').update(`${projectId}:${url}`).digest('hex').slice(0, 24)}`;
}
