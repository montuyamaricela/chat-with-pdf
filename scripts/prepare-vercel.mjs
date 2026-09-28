import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const staticDirectory = resolve(root, '.vercel/output/static');
const functionDirectory = resolve(root, '.vercel/output/functions/index.func');

function removeBuildOnlyFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      removeBuildOnlyFiles(path);
    } else if (/\.(?:map|d\.[cm]?ts)$/.test(entry)) {
      rmSync(path);
    }
  }
}

removeBuildOnlyFiles(functionDirectory);

const packageStore = resolve(functionDirectory, 'node_modules/.pnpm');
for (const entry of readdirSync(packageStore)) {
  if (entry.startsWith('typescript@') || entry.startsWith('@types+')) {
    rmSync(resolve(packageStore, entry), { recursive: true, force: true });
  }
}
rmSync(resolve(functionDirectory, 'node_modules/typescript'), { force: true });

const functionPackagePath = resolve(functionDirectory, 'package.json');
const functionPackage = JSON.parse(readFileSync(functionPackagePath, 'utf8'));
delete functionPackage.dependencies.typescript;
writeFileSync(functionPackagePath, `${JSON.stringify(functionPackage, null, 2)}\n`);

mkdirSync(staticDirectory, { recursive: true });
cpSync(resolve(root, 'dist-web'), staticDirectory, { recursive: true });

writeFileSync(
  resolve(root, '.vercel/output/config.json'),
  `${JSON.stringify({
    version: 3,
    routes: [
      { handle: 'filesystem' },
      { src: '/app(?:/.*)?', dest: '/' },
      { src: '/(.*)', dest: '/index.html' },
    ],
  })}\n`,
);
