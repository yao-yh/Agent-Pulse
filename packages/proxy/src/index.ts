import { Readable, Transform } from 'node:stream';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newId, nowIso, ProxyRequestRecord, ProxyRouteMapping, redactSecretString } from '@agent-pulse/core';
import { AgentPulseStorage } from '@agent-pulse/storage';

export interface RegisterProxyOptions {
  storage: AgentPulseStorage;
}

export function registerProxyRoutes(app: FastifyInstance, options: RegisterProxyOptions): void {
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  refreshProxyRouteMappings(options.storage);
  app.all('/proxy/:proxyKey/*', (request, reply) => handleProxy(request, reply, options.storage));
}

const routeMappings = new Map<string, ProxyRouteMapping>();
const DETAIL_CAPTURE_MAX_LENGTH = 64 * 1024;

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
  const requestSummary = captureRequest(request, body);

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
      if (shouldCaptureStreamingResponse(contentType)) {
        return reply.send(streamResponseWithCapture({
          response,
          contentType,
          onComplete: (responseSummary) => storage.insertProxyRequest(baseRecord(id, mapping, request, upstreamUrl, started, requestSummary, response.status, responseSummary))
        }));
      }
      storage.insertProxyRequest(baseRecord(id, mapping, request, upstreamUrl, started, requestSummary, response.status, capturePassthroughResponse(response, contentType)));
      return reply.send(response.body ? Readable.fromWeb(response.body as any) : undefined);
    }

    const text = await response.text();
    storage.insertProxyRequest(baseRecord(id, mapping, request, upstreamUrl, started, requestSummary, response.status, captureTextResponse(response, contentType, text)));
    return reply.send(text);
  } catch (error) {
    storage.insertProxyRequest({
      ...baseRecord(id, mapping, request, upstreamUrl, started, requestSummary),
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
  requestSummary: Record<string, unknown>,
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
    requestSummary,
    responseSummary,
    createdAt: nowIso()
  };
}

function captureRequest(request: FastifyRequest, forwardedBody: BodyInit | undefined): Record<string, unknown> {
  const target = resolveProxyTarget(request.url);
  const headers = captureField(normalizeHeaders(request.headers));
  const body = captureFullField(normalizeCapturedBody(forwardedBody ?? request.body));
  return captureStructuredDetail({
    method: request.method,
    path: request.url,
    proxyKey: target?.proxyKey,
    upstreamSuffix: target?.suffix,
    headers: headers.value,
    headersTruncated: headers.truncated,
    headersOriginalLength: headers.originalLength,
    body: body.value,
    bodyTruncated: body.truncated,
    bodyOriginalLength: body.originalLength
  });
}

function captureTextResponse(response: Response, contentType: string, text: string): Record<string, unknown> {
  const headers = captureField(responseHeaders(response));
  const body = captureField(normalizeCapturedBody(text));
  return captureStructuredDetail({
    statusCode: response.status,
    statusText: response.statusText,
    headers: headers.value,
    headersTruncated: headers.truncated,
    headersOriginalLength: headers.originalLength,
    contentType,
    bodyCaptured: true,
    body: body.value,
    bodyLength: text.length,
    bodyTruncated: body.truncated,
    bodyOriginalLength: body.originalLength
  });
}

function capturePassthroughResponse(response: Response, contentType: string): Record<string, unknown> {
  return captureDetail({
    statusCode: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
    contentType,
    bodyCaptured: false,
    passthrough: true,
    streaming: contentType.includes('text/event-stream'),
    reason: contentType.includes('text/event-stream') ? 'streaming_response_not_buffered' : 'binary_or_unknown_response_not_buffered'
  });
}

function captureStreamingResponse(response: Response, contentType: string, summary: Record<string, unknown>): Record<string, unknown> {
  return captureDetail({
    statusCode: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
    contentType,
    bodyCaptured: 'sse_summary',
    passthrough: true,
    streaming: true,
    body: summary
  });
}

function captureDetail(value: unknown): Record<string, unknown> {
  const capture = captureField(value);
  if (!capture.truncated) {
    return { value: capture.value, truncated: false, capturedLength: capture.capturedLength, maxLength: DETAIL_CAPTURE_MAX_LENGTH };
  }
  return {
    value: capture.value,
    truncated: true,
    capturedLength: capture.capturedLength,
    originalLength: capture.originalLength,
    maxLength: DETAIL_CAPTURE_MAX_LENGTH
  };
}

function captureStructuredDetail(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactProxyCapture(value);
  const text = JSON.stringify(redacted);
  return { value: redacted, truncated: false, capturedLength: text.length, maxLength: DETAIL_CAPTURE_MAX_LENGTH };
}

function captureField(value: unknown): { value: unknown; truncated: boolean; capturedLength: number; originalLength?: number } {
  const redacted = redactProxyCapture(value);
  const text = redacted === undefined ? '' : JSON.stringify(redacted);
  if (text.length <= DETAIL_CAPTURE_MAX_LENGTH) {
    return { value: redacted, truncated: false, capturedLength: text.length };
  }
  return {
    value: `${text.slice(0, DETAIL_CAPTURE_MAX_LENGTH)}...`,
    truncated: true,
    capturedLength: DETAIL_CAPTURE_MAX_LENGTH,
    originalLength: text.length
  };
}

function captureFullField(value: unknown): { value: unknown; truncated: false; capturedLength: number; originalLength: number } {
  const redacted = redactProxyCapture(value);
  const text = redacted === undefined ? '' : JSON.stringify(redacted);
  return { value: redacted, truncated: false, capturedLength: text.length, originalLength: text.length };
}

function redactProxyCapture(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactProxyCapture(item));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return redactSecretString(value);
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isProxySensitiveKey(childKey, childValue)) output[childKey] = '<redacted>';
    else output[childKey] = redactProxyCapture(childValue, childKey);
  }
  return key && isProxySensitiveKey(key, value) ? '<redacted>' : output;
}

function isProxySensitiveKey(key: string, value: unknown): boolean {
  if (/(_tokens|_token_count|token_count)$/i.test(key) && typeof value === 'number') return false;
  return /(api[_-]?key|token|secret|password|passwd|authorization|cookie|session)/i.test(key);
}

function normalizeCapturedBody(body: unknown): unknown {
  if (body === undefined) return undefined;
  if (body instanceof Uint8Array) return { encoding: 'base64', value: Buffer.from(body).toString('base64') };
  if (typeof body !== 'string') return body;
  return safeJson(body) ?? body;
}

function streamResponseWithCapture(input: {
  response: Response;
  contentType: string;
  onComplete: (responseSummary: Record<string, unknown>) => void;
}): Readable | undefined {
  if (!input.response.body) return undefined;
  const capture = createSseSummaryCapture();
  let stored = false;
  const store = () => {
    if (stored) return;
    stored = true;
    input.onComplete(captureStreamingResponse(input.response, input.contentType, capture.summary()));
  };
  const stream = Readable.fromWeb(input.response.body as any);
  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      capture.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback(null, chunk);
    },
    flush(callback) {
      store();
      callback();
    }
  });
  stream.on('error', store);
  tee.on('close', store);
  return stream.pipe(tee);
}

function createSseSummaryCapture() {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  let parseErrorCount = 0;
  let model: string | undefined;
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const thinking = createBoundedTextAccumulator();
  const text = createBoundedTextAccumulator();

  const processFrame = (frame: string) => {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const rawData = dataLines.join('\n').trim();
    if (!rawData || rawData === '[DONE]') return;
    const data = parseSseJson(rawData);
    if (!data || typeof data !== 'object') {
      parseErrorCount += 1;
      return;
    }
    eventCount += 1;
    applySseEvent(data as Record<string, any>);
  };

  const applySseEvent = (event: Record<string, any>) => {
    if (event.type === 'message_start' && event.message && typeof event.message === 'object') {
      if (typeof event.message.model === 'string') model = event.message.model;
      if (event.message.usage && typeof event.message.usage === 'object') usage = { ...usage, ...event.message.usage };
      return;
    }
    if (event.type === 'content_block_start' && event.content_block && typeof event.content_block === 'object') {
      if (event.content_block.type === 'thinking' && typeof event.content_block.thinking === 'string') thinking.append(event.content_block.thinking);
      if (event.content_block.type === 'text' && typeof event.content_block.text === 'string') text.append(event.content_block.text);
      return;
    }
    if (event.type === 'content_block_delta' && event.delta && typeof event.delta === 'object') {
      if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') thinking.append(event.delta.thinking);
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') text.append(event.delta.text);
      return;
    }
    if (event.type === 'message_delta') {
      if (event.delta && typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason;
      if (event.usage && typeof event.usage === 'object') usage = { ...usage, ...event.usage };
    }
  };

  return {
    append(chunk: Buffer) {
      const text = decoder.decode(chunk, { stream: true });
      if (!text) return;
      buffer += text.replace(/\r\n/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        processFrame(frame);
        separator = buffer.indexOf('\n\n');
      }
    },
    summary() {
      const tail = decoder.decode();
      if (tail) this.append(Buffer.from(tail));
      if (buffer.trim()) {
        processFrame(buffer);
        buffer = '';
      }
      return {
        model,
        usage,
        thinking: thinking.value(),
        text: text.value(),
        stopReason,
        eventCount,
        parseErrorCount,
        truncated: thinking.truncated() || text.truncated()
      };
    }
  };
}

function createBoundedTextAccumulator() {
  const chunks: string[] = [];
  let length = 0;
  let wasTruncated = false;
  return {
    append(value: string) {
      if (!value) return;
      if (length >= DETAIL_CAPTURE_MAX_LENGTH) {
        wasTruncated = true;
        return;
      }
      const remaining = DETAIL_CAPTURE_MAX_LENGTH - length;
      chunks.push(value.slice(0, remaining));
      length += Math.min(value.length, remaining);
      if (value.length > remaining) wasTruncated = true;
    },
    value() {
      return chunks.join('');
    },
    truncated() {
      return wasTruncated;
    }
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

function responseHeaders(response: Response): Record<string, string> {
  const output: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    output[key] = value;
  });
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

function shouldCaptureStreamingResponse(contentType: string): boolean {
  return contentType.includes('text/event-stream');
}

function parseSseJson(text: string): unknown {
  const parsed = safeJson(text);
  if (parsed !== undefined) return parsed;
  if (text.includes('\\"')) return safeJson(text.replace(/\\"/g, '"'));
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

