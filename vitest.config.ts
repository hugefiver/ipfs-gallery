import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'tests/smoke/**', 'tests/audit/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
