import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // Default `npm test` never calls a paid API; @llm tests get their own script in P2.
    testTimeout: 20_000,
  },
});
