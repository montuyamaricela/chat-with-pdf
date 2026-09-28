import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { discoverPapers } from '../lib/paper-discovery';
import {
  createProject, deleteEvidence, ensureResearchSchema, getPaper, getPaperByUrl, getProject,
  listEvidence, listPapers, listProjects, saveEvidence, updateProject,
} from '../lib/research-store';
import { searchResearch } from '../lib/research-retrieval';
import { ensureVectorIndex, PDF_INDEX_NAME, vectorStore } from '../lib/vector-store';

const projectIdSchema = z.string().min(1).max(80);
const pdfUrlSchema = z.url().refine(value => /^https?:\/\//i.test(value), {
  message: 'Enter an http or https PDF URL.',
});
const projectSchema = z.object({
  title: z.string().trim().min(2).max(120),
  researchQuestion: z.string().trim().max(1000).default(''),
});
const paperSchema = z.object({
  projectId: projectIdSchema,
  url: pdfUrlSchema,
  title: z.string().trim().max(300).optional(),
  authors: z.array(z.string().trim().max(120)).max(20).default([]),
  publicationYear: z.number().int().min(1800).max(2100).optional(),
  doi: z.string().trim().max(255).optional(),
  openalexId: z.string().trim().max(255).optional(),
});
const searchSchema = z.object({
  projectId: projectIdSchema,
  query: z.string().trim().min(2).max(2000),
  documentId: z.string().optional(),
});
const evidenceSchema = z.object({
  projectId: projectIdSchema,
  documentId: z.string().min(1),
  vectorId: z.string().min(1),
  kind: z.enum(['finding', 'method', 'limitation', 'context']),
  note: z.string().trim().max(2000).default(''),
});

function aiConfigured() {
  const key = process.env.OPENAI_API_KEY;
  return Boolean(key && key !== 'your-api-key');
}

export const appRoutes = [
  registerApiRoute('/app/status', {
    method: 'GET',
    handler: async c => {
      try {
        await Promise.all([ensureVectorIndex(), ensureResearchSchema()]);
        const result = await vectorStore.pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = $1
              AND indexdef ILIKE '%USING hnsw%'
              AND indexdef ILIKE '%embedding vector_cosine_ops%'`,
          [PDF_INDEX_NAME],
        );
        return c.json({ ready: true, hnsw: result.rows.length > 0, aiConfigured: aiConfigured() });
      } catch {
        return c.json({ ready: false, hnsw: false, aiConfigured: aiConfigured() }, 503);
      }
    },
  }),
  registerApiRoute('/app/projects', {
    method: 'GET',
    handler: async c => c.json({ projects: await listProjects() }),
  }),
  registerApiRoute('/app/projects', {
    method: 'POST',
    handler: async c => {
      const parsed = projectSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Enter a project title of at least two characters.' }, 400);
      return c.json({ project: await createProject(parsed.data.title, parsed.data.researchQuestion) }, 201);
    },
  }),
  registerApiRoute('/app/projects', {
    method: 'PATCH',
    handler: async c => {
      const parsed = projectSchema.extend({ projectId: projectIdSchema })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Enter a valid project title and research question.' }, 400);
      const changed = await updateProject(parsed.data.projectId, parsed.data.title, parsed.data.researchQuestion);
      return changed ? c.json({ updated: true }) : c.json({ error: 'Project not found.' }, 404);
    },
  }),
  registerApiRoute('/app/papers', {
    method: 'GET',
    handler: async c => {
      const projectId = c.req.query('projectId');
      if (!projectId || !await getProject(projectId)) return c.json({ error: 'Project not found.' }, 404);
      const requestedLimit = Number(c.req.query('limit') ?? 50);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 50;
      return c.json(await listPapers(projectId, limit, c.req.query('after'), c.req.query('search')));
    },
  }),
  registerApiRoute('/app/papers', {
    method: 'POST',
    handler: async c => {
      const parsed = paperSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Enter a valid public PDF URL and paper details.' }, 400);
      if (!await getProject(parsed.data.projectId)) return c.json({ error: 'Project not found.' }, 404);
      const existing = await getPaperByUrl(parsed.data.projectId, parsed.data.url);
      if (existing) return c.json({ paper: existing, alreadyIndexed: true });
      if (!aiConfigured()) return c.json({ error: 'Set OPENAI_API_KEY in .env before indexing papers.' }, 503);
      try {
        const workflow = c.get('mastra').getWorkflow('indexPdfWorkflow');
        const run = await workflow.createRun();
        const result = await run.start({ inputData: {
          url: parsed.data.url,
          projectId: parsed.data.projectId,
          titleOverride: parsed.data.title,
          authors: parsed.data.authors,
          publicationYear: parsed.data.publicationYear,
          doi: parsed.data.doi,
          openalexId: parsed.data.openalexId,
        } });
        if (result.status !== 'success') return c.json({ error: 'Indexing failed. Check the PDF URL and server logs.' }, 500);
        const paper = await getPaper(result.result.documentId, parsed.data.projectId);
        return c.json({ paper }, 201);
      } catch {
        return c.json({ error: 'Indexing failed. Check the PDF URL and server logs.' }, 500);
      }
    },
  }),
  registerApiRoute('/app/discover', {
    method: 'GET',
    handler: async c => {
      const query = z.string().trim().min(3).max(250).safeParse(c.req.query('q'));
      if (!query.success) return c.json({ error: 'Enter at least three search characters.' }, 400);
      try {
        return c.json({ papers: await discoverPapers(query.data) });
      } catch {
        return c.json({ error: 'Scholarly discovery is unavailable. Try again shortly or add a PDF URL.' }, 502);
      }
    },
  }),
  registerApiRoute('/app/search', {
    method: 'POST',
    handler: async c => {
      const parsed = searchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Enter a search question.' }, 400);
      if (!await getProject(parsed.data.projectId)) return c.json({ error: 'Project not found.' }, 404);
      if (parsed.data.documentId && !await getPaper(parsed.data.documentId, parsed.data.projectId)) {
        return c.json({ error: 'Paper not found in this project.' }, 404);
      }
      if (!aiConfigured()) return c.json({ error: 'Set OPENAI_API_KEY in .env to search paper content.' }, 503);
      try {
        return c.json({ hits: await searchResearch({ ...parsed.data, limit: 12 }) });
      } catch {
        return c.json({ error: 'Search failed. Check the server logs and API key.' }, 500);
      }
    },
  }),
  registerApiRoute('/app/ask', {
    method: 'POST',
    handler: async c => {
      const parsed = searchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Enter a research question.' }, 400);
      const project = await getProject(parsed.data.projectId);
      if (!project) return c.json({ error: 'Project not found.' }, 404);
      if (parsed.data.documentId && !await getPaper(parsed.data.documentId, parsed.data.projectId)) {
        return c.json({ error: 'Paper not found in this project.' }, 404);
      }
      if (!aiConfigured()) return c.json({ error: 'Set OPENAI_API_KEY in .env to analyze papers.' }, 503);
      try {
        const sources = await searchResearch({ ...parsed.data, limit: 8 });
        if (sources.length === 0) return c.json({ answer: 'I could not find relevant indexed passages in this project.', sources: [] });
        const excerpts = sources.map((hit, index) =>
          `[${index + 1}] ${hit.title}, page ${hit.pageNumber}\n${hit.text.slice(0, 1400)}`,
        ).join('\n\n');
        const response = await c.get('mastra').getAgent('researchAgent').generate(
          `Project research question: ${project.researchQuestion || '(not set)'}\n` +
          `Student question: ${parsed.data.query}\n\nSource excerpts:\n${excerpts}`,
        );
        return c.json({ answer: response.text, sources });
      } catch {
        return c.json({ error: 'Analysis failed. Check the server logs and API key.' }, 500);
      }
    },
  }),
  registerApiRoute('/app/evidence', {
    method: 'GET',
    handler: async c => {
      const projectId = c.req.query('projectId');
      if (!projectId || !await getProject(projectId)) return c.json({ error: 'Project not found.' }, 404);
      return c.json({ evidence: await listEvidence(projectId) });
    },
  }),
  registerApiRoute('/app/evidence', {
    method: 'POST',
    handler: async c => {
      const parsed = evidenceSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Choose a source passage and evidence type.' }, 400);
      const saved = await saveEvidence(parsed.data);
      return saved ? c.json({ saved: true }, 201) : c.json({ error: 'Source passage not found in this project.' }, 404);
    },
  }),
  registerApiRoute('/app/evidence', {
    method: 'DELETE',
    handler: async c => {
      const parsed = z.object({ projectId: projectIdSchema, evidenceId: z.string().min(1) })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Choose evidence to remove.' }, 400);
      const removed = await deleteEvidence(parsed.data.projectId, parsed.data.evidenceId);
      return removed ? c.json({ removed: true }) : c.json({ error: 'Evidence not found.' }, 404);
    },
  }),
];
