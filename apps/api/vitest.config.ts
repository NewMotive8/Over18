import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'], // never pick up compiled copies in dist/
    fileParallelism: false, // tests share one database — run files sequentially
  },
});
