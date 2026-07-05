import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// `test.globals` is off (see vite.config.ts), so RTL's auto-cleanup (which
// relies on a global `afterEach`) doesn't register itself - do it explicitly.
afterEach(() => {
  cleanup();
});
