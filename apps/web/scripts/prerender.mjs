// Manual SSG step (react has no first-party equivalent of vite-ssg, which is
// Vue-only - see the developer report for 10009). Runs after both the client
// build (`vite build`, emits dist/) and the SSR build
// (`vite build --ssr src/entry-server.tsx --outDir dist-ssr`).
//
// For each public route, renders the App to a string via the SSR bundle and
// splices it into the client index.html template at the `<!--app-html-->`
// marker, then writes the result to its own dist/<route>/index.html so the
// static output is directly servable (S3/CloudFront-style) without a server.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const distDir = join(webRoot, 'dist');
const ssrDir = join(webRoot, 'dist-ssr');

const template = readFileSync(join(distDir, 'index.html'), 'utf-8');
if (!template.includes('<!--app-html-->')) {
  throw new Error('dist/index.html is missing the <!--app-html--> marker');
}

const ssrEntryFile = readdirSync(ssrDir).find(
  (name) => name.startsWith('entry-server') && (name.endsWith('.js') || name.endsWith('.mjs')),
);
if (!ssrEntryFile) {
  throw new Error(`No entry-server bundle found in ${ssrDir}`);
}

// Dynamic import() requires a file:// URL for absolute paths on Windows.
const { render } = await import(pathToFileURL(join(ssrDir, ssrEntryFile)).href);

const routes = ['/', '/products', '/pricing'];

for (const url of routes) {
  const appHtml = render(url);
  const html = template.replace('<!--app-html-->', appHtml);
  const outFile =
    url === '/' ? join(distDir, 'index.html') : join(distDir, url.slice(1), 'index.html');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf-8');
  console.log(`prerendered ${url} -> ${outFile}`);
}

// The SSR bundle is a build-time-only artifact - never ship it as a static asset.
if (existsSync(ssrDir)) {
  rmSync(ssrDir, { recursive: true, force: true });
}
