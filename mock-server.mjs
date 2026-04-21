// Tiny HTTP server that serves JSON files from ./mock-data as if it were the
// real Copy Sync backend. Stand-in for the future Next.js API.
//
// Endpoints:
//   GET /projects              -> [{ id, name }]
//   GET /projects/:id          -> full project JSON (strings included)
//
// Each request re-reads from disk, so writers can edit the JSON file and hit
// "refresh" in the plugin to see the change — mirrors the production flow
// (writer edits Excel -> plugin refresh pulls latest).

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'mock-data');
const PORT = Number(process.env.PORT) || 3737;

const CORS_HEADERS = {
  // Figma plugin UI runs in a null-origin iframe; allow everything.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function listProjects() {
  const files = await readdir(DATA_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  return Promise.all(
    jsonFiles.map(async (file) => {
      const raw = await readFile(resolve(DATA_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      return { id: data.id, name: data.name };
    }),
  );
}

async function loadProject(id) {
  const safeId = String(id).replace(/[^a-z0-9_-]/gi, '');
  if (!safeId) return null;
  try {
    const raw = await readFile(resolve(DATA_DIR, `${safeId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/projects') {
      return send(res, 200, await listProjects());
    }

    const match = url.pathname.match(/^\/projects\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && match) {
      const project = await loadProject(match[1]);
      if (!project) return send(res, 404, { error: 'Project not found' });
      return send(res, 200, project);
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`mock-server listening on http://localhost:${PORT}`);
  console.log(`  GET /projects`);
  console.log(`  GET /projects/:id`);
});
