import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';

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
