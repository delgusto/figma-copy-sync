import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, 'dist');
mkdirSync(distDir, { recursive: true });

const watch = process.argv.includes('--watch');

const mainCtx = await esbuild.context({
  entryPoints: [resolve(__dirname, 'src/main.ts')],
  bundle: true,
  outfile: resolve(distDir, 'main.js'),
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  logLevel: 'info',
});

const uiCtx = await esbuild.context({
  entryPoints: [resolve(__dirname, 'src/ui.tsx')],
  bundle: true,
  outfile: resolve(distDir, 'ui.js'),
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

async function buildHtml() {
  const template = readFileSync(resolve(__dirname, 'src/ui.html'), 'utf8');
  const js = readFileSync(resolve(distDir, 'ui.js'), 'utf8');
  const html = template.replace('<!-- UI_SCRIPT -->', `<script>${js}</script>`);
  writeFileSync(resolve(distDir, 'ui.html'), html);
}

if (watch) {
  await mainCtx.watch();
  await uiCtx.watch();
  // Rebuild HTML whenever ui.js changes. Simplest: rebuild on an interval.
  setInterval(() => buildHtml().catch(() => {}), 500);
  console.log('Watching...');
} else {
  await mainCtx.rebuild();
  await uiCtx.rebuild();
  await buildHtml();
  await mainCtx.dispose();
  await uiCtx.dispose();
  console.log('Built to', distDir);
}
