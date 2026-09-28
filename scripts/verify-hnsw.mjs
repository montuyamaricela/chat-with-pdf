import { Pool } from 'pg';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const connectionString = process.env.DATABASE_URL ??
  'postgresql://chatpdf:chatpdf@localhost:5433/chat_with_pdf';
const pool = new Pool({ connectionString });

try {
  const { rows } = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'pdf_sections'
        AND indexdef ILIKE '%USING hnsw%'
        AND indexdef ILIKE '%embedding vector_cosine_ops%'`,
  );
  if (rows.length === 0) {
    throw new Error('No HNSW index found on public.pdf_sections. Start the Mastra API or index a PDF first.');
  }
  for (const row of rows) console.log(`${row.indexname}: ${row.indexdef}`);
} finally {
  await pool.end();
}
