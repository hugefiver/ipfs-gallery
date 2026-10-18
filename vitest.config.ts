import { defineConfig } from 'vitest/config'
import { buildPolicyDefines, parseBuildPolicy } from './build/build-policy'

export default defineConfig({
  define: buildPolicyDefines(parseBuildPolicy({})),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'tests/smoke/**', 'tests/audit/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
