import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import App from './App.tsx';

// SSG entry, built separately (`vite build --ssr src/entry-server.tsx`) and
// consumed by scripts/prerender.mjs. Only ever invoked with the public route
// URLs (/, /products, /pricing) - the auth routes never reach this path, so
// no session/network code runs at build time.
export function render(url: string): string {
  return renderToString(
    <StaticRouter location={url}>
      <App />
    </StaticRouter>,
  );
}
