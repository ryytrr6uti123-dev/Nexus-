import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { bootstrap } from '@mercuryworkshop/proxy-bootstrap';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

function normalizeBasePath(value) {
  const segments = value.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || /[?#]/.test(segment))) {
    throw new Error('NEXUS_BASE_PATH must be a URL path without query strings or traversal segments.');
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

const basePath = normalizeBasePath(process.env.NEXUS_BASE_PATH || '/');
const basePathWithoutTrailingSlash = basePath === '/' ? '/' : basePath.slice(0, -1);
const appPath = path => `${basePath === '/' ? '' : basePath.slice(0, -1)}${path}`;
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));
const adblockerEntry = fileURLToPath(new URL('./adblocker-client.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const { getGameCatalog } = require('./games.cjs');
const { AiQuotaStore } = require('./ai.cjs');
const { handleAiApi } = require('./ai-api.cjs');
const { ProfileStore } = require('./profiles.cjs');
const { handleProfileApi } = require('./profile-api.cjs');
const dataDirectory = process.env.NEXUS_DATA_DIR || path.join(homedir(), '.nexus');
const profileStore = new ProfileStore(path.join(
  dataDirectory,
  'profiles.json',
));
const aiQuotaStore = new AiQuotaStore(path.join(dataDirectory, 'ai-usage.json'));
await Promise.all([profileStore.ready, aiQuotaStore.ready]);
const { routeRequest, routeUpgrade } = await bootstrap({
  swPath: appPath('/sw.js'),
  scramjetControllerApiPath: appPath('/controller/controller.api.js'),
  scramjetControllerInjectPath: appPath('/controller/controller.inject.js'),
  scramjetControllerSwPath: appPath('/controller/controller.sw.js'),
  scramjetBundlePath: appPath('/scram/scramjet.js'),
  scramjetWasmPath: appPath('/scram/scramjet.wasm'),
  scramjetUtilsBundlePath: appPath('/scram/scramjet-utils.js'),
  libcurlClientPath: appPath('/clients/libcurl-client.js'),
  bootstrapInitPath: appPath('/bootstrap-init.js'),
});
const { outputFiles } = await build({
  entryPoints: [adblockerEntry],
  bundle: true,
  format: 'iife',
  globalName: 'NexusAdblocker',
  legalComments: 'inline',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const adblockerBundle = outputFiles[0].text;

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  const { pathname } = requestUrl;
  if (pathname === appPath('/adblocker.js')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : adblockerBundle);
    return;
  }

  if (pathname === appPath('/music-profile.js')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    try {
      const source = await readFile(new URL('./music-profile.js', import.meta.url));
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : source);
    } catch (error) {
      console.error('Could not serve Nexus profile and music client.', error);
      response.writeHead(500);
      response.end('Could not load Nexus profile and music client.');
    }
    return;
  }

  if (routeRequest(request, response)) return;

  if (await handleAiApi(request, response, {
    basePath,
    profileStore,
    aiQuotaStore,
  })) return;

  if (await handleProfileApi(request, response, { basePath, profileStore })) return;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  if (basePath !== '/' && pathname === '/') {
    response.writeHead(308, { Location: `${basePath}${requestUrl.search}` });
    response.end();
    return;
  }
  if (basePath !== '/' && pathname === basePathWithoutTrailingSlash) {
    response.writeHead(308, { Location: `${basePath}${requestUrl.search}` });
    response.end();
    return;
  }
  if (pathname === appPath('/api/games')) {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end();
      return;
    }
    try {
      const games = await getGameCatalog();
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      response.end(JSON.stringify(games));
    } catch (error) {
      console.error('Could not load the GameMonetize catalog.', error);
      response.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ error: 'The game catalog is temporarily unavailable.' }));
    }
    return;
  }
  const pagePaths = basePath === '/'
    ? new Set(['/', '/index.html'])
    : new Set([basePath, `${basePath}index.html`]);
  if (!pagePaths.has(pathname)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const source = await readFile(indexPath, 'utf8');
    const html = source.replace(
      '<meta name="nexus-base-path" content="/">',
      `<meta name="nexus-base-path" content="${basePath}">`,
    );
    if (basePath !== '/' && html === source) {
      throw new Error('Could not inject the configured Nexus base path.');
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch (error) {
    console.error('Could not serve Nexus preview.', error);
    response.writeHead(500);
    response.end('Could not load Nexus preview.');
  }
});

server.on('upgrade', (request, socket, head) => {
  if (!routeUpgrade(request, socket, head)) socket.destroy();
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => {
  console.log(`Nexus Scramjet preview listening on port ${port}.`);
});
