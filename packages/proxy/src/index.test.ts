import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createStorage } from '@agent-pulse/storage';
import { registerProxyRoutes } from './index.js';

describe('proxy route mappings', () => {
  it('uses persisted in-memory route mappings for Claude Code upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-proxy-'));
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const upstream = Fastify();
    upstream.post('/v1/messages', async () => ({ ok: true, upstream: 'mapped' }));
    const upstreamBaseUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
    storage.upsertProxyRouteMapping({
      integration: 'claude-code',
      provider: 'claude-code',
      localRoute: '/proxy/claude-code',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/claude-code',
      upstreamBaseUrl
    });

    const proxy = Fastify();
    registerProxyRoutes(proxy, { storage });
    const response = await proxy.inject({ method: 'POST', url: '/proxy/claude-code/v1/messages', payload: { hello: 'world' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, upstream: 'mapped' });
    await proxy.close();
    await upstream.close();
    storage.close();
  });
});
