import { Readable } from 'node:stream';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newId, nowIso, ProxyRequestRecord, ProxyRouteMapping, redactSecrets, summarizeUnknown } from '@agent-pulse/core';
import { AgentPulseStorage } from '@agent-pulse/storage';

export interface RegisterProxyOptions {
  storage: AgentPulseStorage;
}

export function registerProxyRoutes(app: FastifyInstance, options: RegisterProxyOptions): void {
  refreshProxyRouteMappings(options.storage);
  app.all('/proxy/:proxyKey/*', (request, reply) => handleProxy(request, reply, options.storage));
}

const routeMappings = new Map<string, ProxyRouteMapping>();

export function refreshProxyRouteMappings(storage: AgentPulseStorage): void {
  routeMappings.clear();
  for (const mapping of storage.listProxyRouteMappings()) {
    routeMappings.set(mapping.proxyKey, mapping);
    routeMappings.set(mapping.integration, mapping);
  }
}

async function handleProxy(
  request: FastifyRequest,
  reply: FastifyReply,
  storage: AgentPulseStorage
): Promise<void> {
  const started = Date.now();
  refreshProxyRouteMappings(storage);
  const target = resolveProxyTarget(request.url);
  if (!target) {
    reply.status(404).send({ error: 'proxy_mapping_not_found' });
    return;
  }
  const mapping = routeMappings.get(target.proxyKey);
  if (!mapping) {
    reply.status(404).send({ error: 'proxy_mapping_not_found', proxyKey: target.proxyKey });
    return;
  }
  const upstreamUrl = `${mapping.upstreamBaseUrl.replace(/\/$/, '')}${target.suffix}`;
  const id = newId('proxy');
  const headers = normalizeHeaders(request.headers);
  delete headers.host;
  delete headers['content-length'];
  const body = serializeRequestBody(request);

  try {
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body
    });
    response.headers.forEach((value, key) => reply.header(key, value));
    reply.status(response.status);

    const contentType = response.headers.get('content-type') || '';
    if (shouldPassthroughResponse(response, contentType)) {
      storage.insertProxyRequest(baseRecord(id, mapping, request, upstreamUrl, started, response.status, { passthrough: true, streaming: contentType.includes('text/event-stream') }));
      return reply.send(response.body ? Readable.fromWeb(response.body as any) : undefined);
    }

    const text = await response.text();
    storage.insertProxyRequest(baseRecord(id, mapping, request, upstreamUrl, started, response.status, summarizeUnknown(safeJson(text) ?? text)));
    return reply.send(text);
  } catch (error) {
    storage.insertProxyRequest({
      ...baseRecord(id, mapping, request, upstreamUrl, started),
      error: String(error)
    });
    reply.status(502).send({ error: 'proxy_failed', message: String(error) });
  }
}

function baseRecord(
  id: string,
  mapping: ProxyRouteMapping,
  request: FastifyRequest,
  upstreamUrl: string,
  started: number,
  statusCode?: number,
  responseSummary?: Record<string, unknown>
): ProxyRequestRecord {
  return {
    id,
    provider: mapping.provider as ProxyRequestRecord['provider'],
    proxyKey: mapping.proxyKey,
    apiProtocol: mapping.apiProtocol,
    method: request.method,
    path: request.url,
    upstreamUrl,
    statusCode,
    durationMs: Date.now() - started,
    requestSummary: summarizeUnknown(redactSecrets({ headers: request.headers, body: request.body ?? {} })),
    responseSummary,
    createdAt: nowIso()
  };
}

function resolveProxyTarget(url: string): { proxyKey: string; suffix: string } | null {
  const match = url.match(/^\/proxy\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/);
  if (!match) return null;
  const proxyKey = decodeURIComponent(match[1] || '');
  if (!proxyKey) return null;
  const suffix = `${match[2] || '/'}${match[3] || ''}`;
  return { proxyKey, suffix };
}

function normalizeHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) output[key] = value.join(', ');
    else if (value !== undefined) output[key] = String(value);
  }
  return output;
}

function serializeRequestBody(request: FastifyRequest): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = request.body;
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body as BodyInit;
  return JSON.stringify(body);
}

function shouldPassthroughResponse(response: Response, contentType: string): boolean {
  if (!response.body) return false;
  if (contentType.includes('text/event-stream')) return true;
  if (contentType.includes('application/json') || contentType.includes('+json') || contentType.startsWith('text/')) return false;
  return true;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

