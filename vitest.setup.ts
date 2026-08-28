import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `vitest.config.ts` does not enable `test.globals`, so RTL's automatic
// per-test cleanup (which hooks into a global `afterEach`) never registers.
// Unmount explicitly after every test so component tests never leak DOM
// nodes into the next test in the same file.
afterEach(() => {
  cleanup();
});
