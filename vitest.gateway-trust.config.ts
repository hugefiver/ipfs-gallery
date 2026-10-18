import { defineConfig } from 'vitest/config'
import { buildPolicyDefines, parseBuildPolicy } from './build/build-policy'

export default defineConfig({
  define: buildPolicyDefines(parseBuildPolicy({ IPFS_GALLERY_TRUSTLESS: 'false' })),
  test: {
    environment: 'node',
    include: ['tests/network/build-policy.test.ts', 'tests/service-worker/gateway-trust.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
