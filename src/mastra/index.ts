import { Mastra } from '@mastra/core/mastra';
import { VercelDeployer } from '@mastra/deployer-vercel';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { indexPdfWorkflow } from './workflows/index-pdf';
import { pdfChatAgent } from './agents/pdf-chat-agent';
import { researchAgent } from './agents/research-agent';
import { vectorStore } from './lib/vector-store';
import { appRoutes } from './routes/app-routes';

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  workflows: { indexPdfWorkflow },
  agents: { pdfChatAgent, researchAgent },
  vectors: { vectorStore },
  storage: new PostgresStore({
    id: 'mastra-storage',
    pool: vectorStore.pool,
  }),
  server: {
    apiRoutes: appRoutes,
    cors: { origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' },
  },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
