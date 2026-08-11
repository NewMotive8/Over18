import { defineConfig } from 'vitest/config';

/**
 * Web tests (US-18). The repo has no browser-test framework; these use the
 * platform-independent navigation model plus `react-dom/server` static rendering
 * (node environment, automatic JSX) to verify the shell, routes, and active
 * state without adding a heavyweight DOM/browser stack.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
