import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createStorage } from '@agent-pulse/storage';
import type { AgentPulseStorage } from '@agent-pulse/storage';
import { registerProxyRoutes } from './index.js';
import { selectResponseParser } from './parsers.js';
import { selectRequestSerializer } from './serializers.js';

describe('proxy serializer and parser selection', () => {
  it('selects model-specific serializers and falls back to protocol defaults', () => {
    expect(selectRequestSerializer({ apiProtocol: 'openai-compatible', body: { model: 'GPT-5.5' } })).toMatchObject({
      matchedBy: 'model',
      modelProvider: 'chatgpt',
      serializer: { id: 'openai-compatible.chatgpt' }
    });
    expect(selectRequestSerializer({ apiProtocol: 'openai-compatible', body: { model: 'glm-5.1' } })).toMatchObject({
      matchedBy: 'model',
      modelProvider: 'glm',
      serializer: { id: 'openai-compatible.glm' }
    });
    expect(selectRequestSerializer({ apiProtocol: 'anthropic-compatible', body: { model: 'deepseek-v4-pro' } })).toMatchObject({
      matchedBy: 'model',
      modelProvider: 'deepseek',
      serializer: { id: 'anthropic-compatible.deepseek' }
    });
    expect(selectRequestSerializer({ apiProtocol: 'anthropic-compatible', body: { model: 'unknown-model' } })).toMatchObject({
      matchedBy: 'protocol',
      serializer: { id: 'anthropic-compatible.default' }
    });
  });

  it('selects agent parsers by MAJOR.MINOR and falls back to the latest parser', () => {
    expect(selectResponseParser({ agent: 'claude-code', apiProtocol: 'anthropic-compatible', agentVersion: '1.0.7', maxTextLength: 1024 })).toMatchObject({
      matchedBy: 'agent-major-minor',
      parser: { id: 'claude-code.1.0' }
    });
    expect(selectResponseParser({ agent: 'claude-code', apiProtocol: 'anthropic-compatible', agentVersion: '9.9.0', maxTextLength: 1024 })).toMatchObject({
      matchedBy: 'agent-latest',
      dynamicLoadDeferred: true,
      parser: { id: 'claude-code.1.0' }
    });
    expect(selectResponseParser({ agent: 'unknown-agent', apiProtocol: 'openai-compatible', maxTextLength: 1024 })).toMatchObject({
      matchedBy: 'protocol-latest',
      parser: { id: 'openai-compatible.1.0' }
    });
  });
});

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

  it('captures redacted request and response details for non-stream traffic', async () => {
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
      url: '/proxy/claude-code/v1/messages?detail=1',
      headers: { 'x-context-id': 'ctx-123', authorization: 'Bearer sk-secretsecretsecretsecret' },
      payload: { message: 'hello', metadata: { token: 'sk-bodysecretsecretsecret' } }
    });

    const record = storage.listProxyRequests()[0];
    expect(record?.requestSummary).toMatchObject({
      value: {
        method: 'POST',
        path: '/proxy/claude-code/v1/messages?detail=1',
        proxyKey: 'claude-code',
        upstreamSuffix: '/v1/messages?detail=1',
        headers: { 'x-context-id': 'ctx-123', authorization: '<redacted>' },
        body: { message: 'hello', metadata: { token: '<redacted>' } }
      },
      truncated: false
    });
    expect(record?.responseSummary).toMatchObject({
      value: {
        statusCode: 200,
        bodyCaptured: true,
        body: { ok: true, path: '/v1/messages?detail=1' }
      },
      truncated: false
    });
    expect(JSON.stringify(record)).not.toContain('sk-secretsecretsecretsecret');
    expect(JSON.stringify(record)).not.toContain('sk-bodysecretsecretsecret');
    await close();
  });

  it('captures raw forwarded request body when Fastify does not parse it as JSON', async () => {
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

    const response = await proxy.inject({
      method: 'POST',
      url: '/proxy/opencode/raw',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('raw-request-body')
    });

    const record = storage.listProxyRequests()[0];
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('raw-request-body');
    expect(record?.requestSummary).toMatchObject({
      value: {
        body: { encoding: 'base64', value: Buffer.from('raw-request-body').toString('base64') }
      },
      truncated: false
    });
    await close();
  });

  it('captures full redacted request bodies even when they exceed the display cap', async () => {
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

    await proxy.inject({
      method: 'POST',
      url: '/proxy/opencode/v1/chat/completions',
      payload: { prompt: 'x'.repeat(70 * 1024), token: 'sk-bodysecretsecretsecret' }
    });

    const record = storage.listProxyRequests()[0];
    expect(record?.requestSummary?.truncated).toBe(false);
    expect((record?.requestSummary?.value as any)?.bodyTruncated).toBe(false);
    expect((record?.requestSummary?.value as any)?.body.prompt).toHaveLength(70 * 1024);
    expect((record?.requestSummary?.value as any)?.body.token).toBe('<redacted>');
    expect(JSON.stringify(record?.requestSummary)).not.toContain('sk-bodysecretsecretsecret');
    await close();
  });

  it('keeps request body visible when captured headers are oversized', async () => {
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
      headers: { 'x-large-context': 'h'.repeat(70 * 1024) },
      payload: { message: 'body still visible' }
    });

    const value = storage.listProxyRequests()[0]?.requestSummary?.value as any;
    expect(value.headersTruncated).toBe(true);
    expect(value.body).toEqual({ message: 'body still visible' });
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
    await waitForProxyRequestCount(storage, 2);
    expect(storage.listProxyRequests().some((record) => (record.responseSummary?.value as any)?.passthrough === true)).toBe(true);
    expect(storage.listProxyRequests().some((record) => (record.responseSummary?.value as any)?.bodyCaptured === 'sse_summary')).toBe(true);
    expect(storage.listProxyRequests().some((record) => (record.responseSummary?.value as any)?.bodyCaptured === false)).toBe(true);
    await close();
  });

  it('extracts model, usage, thinking, and text from Anthropic-style SSE without storing raw events', async () => {
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

    const response = await proxy.inject({ method: 'GET', url: '/proxy/claude-code/anthropic-sse' });
    await waitForProxyRequestCount(storage, 1);
    const record = storage.listProxyRequests()[0];
    const body = (record?.responseSummary?.value as any)?.body;

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: message_start');
    expect(body).toMatchObject({
      model: 'deepseek-v4-pro',
      usage: {
        input_tokens: 54,
        cache_read_input_tokens: 25344,
        output_tokens: 54,
        service_tier: 'standard'
      },
      thinking: 'The with.',
      text: 'I?',
      toolCalls: [
        {
          id: 'toolu_read_1',
          type: 'tool_use',
          name: 'read_file',
          index: 2,
          arguments: '{"path":"/tmp/a.txt"}',
          input: { path: '/tmp/a.txt' }
        }
      ],
      stopReason: 'end_turn',
      parseErrorCount: 0
    });
    expect(JSON.stringify(record)).not.toContain('event: message_start');
    expect(JSON.stringify(record)).not.toContain('thinking_delta');
    await close();
  });

  it('extracts model, usage, thinking, and text from OpenAI-style SSE through the selected agent parser', async () => {
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

    const response = await proxy.inject({
      method: 'GET',
      url: '/proxy/codex/openai-sse',
      headers: { 'x-agent-version': '9.9.0' }
    });
    await waitForProxyRequestCount(storage, 1);
    const record = storage.listProxyRequests()[0];
    const body = (record?.responseSummary?.value as any)?.body;

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: {"id":"chatcmpl-test"');
    expect(body).toMatchObject({
      model: 'GPT-5.5',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15
      },
      thinking: 'plan',
      text: 'Hello',
      toolCalls: [
        {
          id: 'call_weather',
          type: 'function',
          name: 'get_weather',
          index: 0,
          arguments: '{"city":"Shanghai"}',
          input: { city: 'Shanghai' }
        }
      ],
      stopReason: 'stop',
      parseErrorCount: 0
    });
    expect(JSON.stringify(record)).not.toContain('chatcmpl-test');
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
  upstream.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  upstream.all('/v1/chat/completions', async (request) => ({ ok: true, path: request.url }));
  upstream.all('/v1/messages', async (request) => ({ ok: true, path: request.url }));
  upstream.post('/raw', async (request) => request.body);
  upstream.get('/error', async (_request, reply) => reply.status(500).send({ error: 'upstream_failed' }));
  upstream.get('/sse', async (_request, reply) => {
    reply.header('content-type', 'text/event-stream');
    return 'data: hello\n\n';
  });
  upstream.get('/anthropic-sse', async (_request, reply) => {
    reply.header('content-type', 'text/event-stream');
    return [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"c0070c42-d79c-4717-9666-68d3418e83ea","type":"message","role":"assistant","model":"deepseek-v4-pro","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":54,"cache_creation_input_tokens":0,"cache_read_input_tokens":25344,"output_tokens":0,"service_tier":"standard"}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" with"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"."}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"?"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_read_1","name":"read_file","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":":\\"/tmp/a.txt\\"}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":54,"cache_creation_input_tokens":0,"cache_read_input_tokens":25344,"output_tokens":54,"service_tier":"standard"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      ''
    ].join('\n');
  });
  upstream.get('/openai-sse', async (_request, reply) => {
    reply.header('content-type', 'text/event-stream');
    return [
      'data: {"id":"chatcmpl-test","model":"GPT-5.5","choices":[{"delta":{"reasoning_content":"plan"}}]}',
      '',
      'data: {"id":"chatcmpl-test","model":"GPT-5.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\""}}]}}]}',
      '',
      'data: {"id":"chatcmpl-test","model":"GPT-5.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Shanghai\\"}"}}]}}]}',
      '',
      'data: {"id":"chatcmpl-test","model":"GPT-5.5","choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"id":"chatcmpl-test","model":"GPT-5.5","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n');
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

async function waitForProxyRequestCount(storage: AgentPulseStorage, count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (storage.listProxyRequests().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(storage.listProxyRequests()).toHaveLength(count);
}
