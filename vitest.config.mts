import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Git as a fresh install: none of the machine's config, none of the variables a hook exports.
    setupFiles: ['tests/setup.ts'],
    // Each test drives real git processes in temporary repositories.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
