import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'matchmaking/index': 'src/matchmaking/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2020',
    dts: true,
    sourcemap: true,
  },
  {
    entry: { edgegap: 'src/browser.ts' },
    format: ['esm', 'iife'],
    outDir: 'dist/browser',
    platform: 'browser',
    target: 'es2020',
    globalName: 'Edgegap',
    dts: false,
    minify: true,
    sourcemap: true,
  },
])
