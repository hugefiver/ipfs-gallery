import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/transport-patches/*.test.ts', 'tests/support/ipfs-provider.test.ts', 'tests/support/sw-network.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
})
