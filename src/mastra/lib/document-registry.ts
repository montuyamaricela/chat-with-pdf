import {
  DEFAULT_PROJECT_ID, ensureResearchSchema, getPaper, listPapers, recordPaper,
  type PaperInput,
} from './research-store';

// Kept for the original Mastra Studio tools and workflow.
export const ensureRegistry = ensureResearchSchema;

export async function recordDocument(document: Omit<PaperInput, 'authors'> & { authors?: string[] }) {
  return recordPaper({ ...document, authors: document.authors ?? [] });
}

export async function listDocuments(limit: number, after?: string) {
  const result = await listPapers(DEFAULT_PROJECT_ID, limit, after);
  return { documents: result.papers, nextCursor: result.nextCursor };
}

export async function getDocument(documentId: string) {
  return getPaper(documentId);
}
