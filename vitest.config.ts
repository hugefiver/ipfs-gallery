import { defineConfig } from 'vitest/config'
import { buildPolicyDefines, parseBuildPolicy } from './build/build-policy.ts'

export default defineConfig({
  define: buildPolicyDefines(parseBuildPolicy({})),
  test: {
    pool: 'threads',
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'tests/smoke/**', 'tests/audit/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
