import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newId, nowIso, ProxyRequestRecord, ProxyRouteMapping, redactSecrets, summarizeUnknown } from '@agent-pulse/core';
import { AgentPulseStorage } from '@agent-pulse/storage';

export interface RegisterProxyOptions {
  storage: AgentPulseStorage;
}

export function registerProxyRoutes(app: FastifyInstance, options: RegisterProxyOptions): void {
  refreshProxyRouteMappings(options.storage);
  app.all('/proxy/openai/*', (request, reply) => handleProxy('openai', request, reply, options.storage));
  app.all('/proxy/anthropic/*', (request, reply) => handleProxy('anthropic', request, reply, options.storage));
  app.all('/proxy/codex/*', (request, reply) => handleProxy('codex', request, reply, options.storage));
  app.all('/proxy/claude-code/*', (request, reply) => handleProxy('claude-code', request, reply, options.storage));
}

const routeMappings = new Map<string, ProxyRouteMapping>();

export function refreshProxyRouteMappings(storage: AgentPulseStorage): void {
  routeMappings.clear();
  for (const mapping of storage.listProxyRouteMappings()) {
    routeMappings.set(mapping.integration, mapping);
    routeMappings.set(String(mapping.provider), mapping);
  }
}

async function handleProxy(
  provider: ProxyRequestRecord['provider'],
  request: FastifyRequest,
  reply: FastifyReply,
  storage: AgentPulseStorage
): Promise<void> {
  const started = Date.now();
  refreshProxyRouteMappings(storage);
  const upstreamBase = resolveUpstream(provider);
  const suffix = request.url.replace(/^\/proxy\/[^/]+/, '');
  const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}${suffix || '/'}`;
  const id = newId('proxy');
  const headers = { ...(request.headers as Record<string, string>) };
  delete headers.host;
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);

  try {
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body
    });
    response.headers.forEach((value, key) => reply.header(key, value));
    reply.status(response.status);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && response.body) {
      storage.insertProxyRequest(baseRecord(id, provider, request, upstreamUrl, started, response.status, { streaming: true }));
      return reply.send(response.body);
    }

    const text = await response.text();
    storage.insertProxyRequest(baseRecord(id, provider, request, upstreamUrl, started, response.status, summarizeUnknown(safeJson(text) ?? text)));
    return reply.send(text);
  } catch (error) {
    storage.insertProxyRequest({
      ...baseRecord(id, provider, request, upstreamUrl, started),
      error: String(error)
    });
    reply.status(502).send({ error: 'proxy_failed', message: String(error) });
  }
}

function baseRecord(
  id: string,
  provider: ProxyRequestRecord['provider'],
  request: FastifyRequest,
  upstreamUrl: string,
  started: number,
  statusCode?: number,
  responseSummary?: Record<string, unknown>
): ProxyRequestRecord {
  return {
    id,
    provider,
    method: request.method,
    path: request.url,
    upstreamUrl,
    statusCode,
    durationMs: Date.now() - started,
    requestSummary: summarizeUnknown(redactSecrets(request.body ?? {})),
    responseSummary,
    createdAt: nowIso()
  };
}

function resolveUpstream(provider: ProxyRequestRecord['provider']): string {
  const mapped = routeMappings.get(provider);
  if (mapped?.upstreamBaseUrl) return mapped.upstreamBaseUrl;
  if (provider === 'anthropic' || provider === 'claude-code') {
    return process.env.AGENT_PULSE_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
  }
  return process.env.AGENT_PULSE_OPENAI_UPSTREAM || 'https://api.openai.com';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

