import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createStorage } from '@agent-pulse/storage';
import { registerProxyRoutes } from './index.js';

describe('proxy route mappings', () => {
  it('uses proxyKey mapping for Claude Code upstream and preserves path/query', async () => {
    const { proxy, storage, upstreamBaseUrl, close } = await createProxyHarness();
    const upstream = Fastify();
    upstream.post('/v1/messages', async (request) => ({ ok: true, upstream: 'mapped', url: request.url }));
    const mappedBaseUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
    storage.upsertProxyRouteMapping({
      integration: 'claude-code',
      provider: 'claude-code',
      proxyKey: 'claude-code',
      apiProtocol: 'anthropic-compatible',
      localRoute: '/proxy/claude-code',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/claude-code',
      upstreamBaseUrl: mappedBaseUrl
    });

    const response = await proxy.inject({ method: 'POST', url: '/proxy/claude-code/v1/messages?beta=1', payload: { hello: 'world' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, upstream: 'mapped', url: '/v1/messages?beta=1' });
    expect(storage.listProxyRequests()[0]?.proxyKey).toBe('claude-code');
    expect(storage.listProxyRequests()[0]?.apiProtocol).toBe('anthropic-compatible');
    await upstream.close();
    await close();
  });

  it('supports opencode proxyKey mappings', async () => {
    const { proxy, storage, upstreamBaseUrl, close } = await createProxyHarness();
    storage.upsertProxyRouteMapping({
      integration: 'opencode',
      provider: 'opencode',
      proxyKey: 'opencode',
      apiProtocol: 'openai-compatible',
      localRoute: '/proxy/opencode',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/opencode',
      upstreamBaseUrl
    });

    const response = await proxy.inject({ method: 'POST', url: '/proxy/opencode/v1/chat/completions', payload: { model: 'test' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: '/v1/chat/completions' });
    expect(storage.listProxyRequests()[0]?.provider).toBe('opencode');
    await close();
  });

  it('returns 404 when proxyKey mapping is missing', async () => {
    const { proxy, upstreamBaseUrl, close } = await createProxyHarness();
    const response = await proxy.inject({ method: 'POST', url: '/proxy/unknown/v1/messages', payload: { hello: 'world' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'proxy_mapping_not_found', proxyKey: 'unknown' });
    await close();
  });

  it('passes upstream errors through without converting them to 502', async () => {
    const { proxy, storage, upstreamBaseUrl, close } = await createProxyHarness();
    storage.upsertProxyRouteMapping({
      integration: 'codex',
      provider: 'codex',
      proxyKey: 'codex',
      apiProtocol: 'openai-compatible',
      localRoute: '/proxy/codex',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/codex',
      upstreamBaseUrl
    });

    const response = await proxy.inject({ method: 'GET', url: '/proxy/codex/error' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'upstream_failed' });
    expect(storage.listProxyRequests()[0]?.statusCode).toBe(500);
    await close();
  });

  it('redacts sensitive headers and body values before storage', async () => {
    const { proxy, storage, upstreamBaseUrl, close } = await createProxyHarness();
    storage.upsertProxyRouteMapping({
      integration: 'claude-code',
      provider: 'claude-code',
      proxyKey: 'claude-code',
      apiProtocol: 'anthropic-compatible',
      localRoute: '/proxy/claude-code',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/claude-code',
      upstreamBaseUrl
    });

    await proxy.inject({
      method: 'POST',
      url: '/proxy/claude-code/v1/messages',
      headers: { authorization: 'Bearer sk-secretsecretsecretsecret', cookie: 'sid=abc', 'x-api-key': 'sk-testsecretsecretsecret' },
      payload: { token: 'sk-bodysecretsecretsecret', message: 'hello' }
    });

    const stored = JSON.stringify(storage.listProxyRequests()[0]);
    expect(stored).not.toContain('sk-secretsecretsecretsecret');
    expect(stored).not.toContain('sid=abc');
    expect(stored).not.toContain('sk-bodysecretsecretsecret');
    expect(stored).toContain('<redacted>');
    await close();
  });

  it('passes SSE and binary responses through', async () => {
    const { proxy, storage, upstreamBaseUrl, close } = await createProxyHarness();
    storage.upsertProxyRouteMapping({
      integration: 'claude-code',
      provider: 'claude-code',
      proxyKey: 'claude-code',
      apiProtocol: 'anthropic-compatible',
      localRoute: '/proxy/claude-code',
      proxyBaseUrl: 'http://127.0.0.1:8080/proxy/claude-code',
      upstreamBaseUrl
    });

    const sse = await proxy.inject({ method: 'GET', url: '/proxy/claude-code/sse' });
    const binary = await proxy.inject({ method: 'GET', url: '/proxy/claude-code/binary' });

    expect(sse.statusCode).toBe(200);
    expect(sse.body).toContain('data: hello');
    expect(binary.statusCode).toBe(200);
    expect(binary.rawPayload.toString()).toBe('abc');
    expect(storage.listProxyRequests().some((record) => record.responseSummary?.passthrough === true)).toBe(true);
    await close();
  });

  it('normalizes legacy mappings without proxyKey and apiProtocol', async () => {
    const { storage, upstreamBaseUrl, close } = await createProxyHarness();
    storage.setSetting('proxy.routeMappings', [
      {
        integration: 'claude-code',
        provider: 'claude-code',
        localRoute: '/proxy/claude-code',
        proxyBaseUrl: 'http://127.0.0.1:8080/proxy/claude-code',
        upstreamBaseUrl
      }
    ]);

    const mapping = storage.listProxyRouteMappings()[0];
    expect(mapping.proxyKey).toBe('claude-code');
    expect(mapping.apiProtocol).toBe('anthropic-compatible');
    await close();
  });
});

async function createProxyHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-proxy-'));
  const storage = createStorage({ databasePath: join(dir, 'test.db') });
  const upstream = Fastify();
  upstream.all('/v1/chat/completions', async (request) => ({ ok: true, path: request.url }));
  upstream.all('/v1/messages', async (request) => ({ ok: true, path: request.url }));
  upstream.get('/error', async (_request, reply) => reply.status(500).send({ error: 'upstream_failed' }));
  upstream.get('/sse', async (_request, reply) => {
    reply.header('content-type', 'text/event-stream');
    return 'data: hello\n\n';
  });
  upstream.get('/binary', async (_request, reply) => {
    reply.header('content-type', 'application/octet-stream');
    return Buffer.from('abc');
  });
  const upstreamBaseUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const proxy = Fastify();
  registerProxyRoutes(proxy, { storage });
  return {
    proxy,
    storage,
    upstreamBaseUrl,
    close: async () => {
      await proxy.close();
      await upstream.close();
      storage.close();
    }
  };
}
