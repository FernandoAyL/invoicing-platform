import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
// Self-hosted fonts (no runtime Google Fonts <link> - see docs/design-system.md).
// Weight subset matches what the comp actually uses: Sans 400/500/600/700,
// Mono 400/500/600. Latin-only subset (the UI copy is English) instead of
// the default `*.css` (which bundles cyrillic/greek/vietnamese too) to avoid
// shipping ~600KB of glyphs nothing on this site uses.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found');
}

// Client entry: a plain (non-hydrating) render. Public routes ship
// prerendered HTML for crawlers (see entry-server.tsx + scripts/prerender.mjs);
// once this bundle loads it re-renders fresh on top rather than hydrating,
// which sidesteps any server/client markup mismatch risk for a scaffold.
createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
