import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  noExternal: [
    '@agent-pulse/analyzers',
    '@agent-pulse/channels',
    '@agent-pulse/core',
    '@agent-pulse/installer',
    '@agent-pulse/integrations',
    '@agent-pulse/inventory',
    '@agent-pulse/probes',
    '@agent-pulse/proxy',
    '@agent-pulse/server',
    '@agent-pulse/storage'
  ]
});
