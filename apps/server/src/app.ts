import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { analyzeEvent } from '@agent-pulse/analyzers';
import { sendNotification } from '@agent-pulse/channels';
import {
  AgentEvent,
  AgentEventType,
  AgentSourceType,
  newId,
  nowIso,
  redactSecrets,
  stableId
} from '@agent-pulse/core';
import { diffInventory, scanInventory } from '@agent-pulse/inventory';
import { applyInstall, planInstall, rollbackLatest, scan } from '@agent-pulse/installer';
import { registerProxyRoutes } from '@agent-pulse/proxy';
import { AgentPulseStorage, createStorage } from '@agent-pulse/storage';

export interface BuildAppOptions {
  storage?: AgentPulseStorage;
  workspaceDir?: string;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const storage = options.storage || createStorage();
  const workspaceDir = options.workspaceDir || process.cwd();
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true, service: 'agent-pulse', timestamp: nowIso() }));
  app.get('/api/health', async () => ({ ok: true, service: 'agent-pulse', timestamp: nowIso() }));

  app.post('/ingest/hook/:integration/:event', async (request, reply) => {
    const params = request.params as { integration: string; event: AgentEventType };
    const body = (request.body || {}) as Record<string, unknown>;
    const event = normalizeHookEvent(params.integration, params.event, body);
    const analysis = analyzeEvent(event);
    event.riskLevel = analysis.riskLevel;
    const result = storage.insertEvent(event);
    storage.insertAnalysis(analysis);
    storage.updateEventRisk(event.id, analysis.riskLevel);
    if (result.inserted && shouldNotify(event.eventType, analysis.riskLevel)) {
      const notification = await sendNotification({
        channel: process.platform === 'win32' ? 'windows' : 'webhook',
        title: `AgentPulse: ${event.eventType}`,
        message: `${event.source} ${event.eventType} ${analysis.riskLevel}`,
        event
      });
      storage.insertNotification({
        id: newId('notification'),
        channel: notification.channel,
        success: notification.success,
        title: `AgentPulse: ${event.eventType}`,
        message: `${event.source} ${event.eventType}`,
        error: notification.error
      });
    }
    reply.send({ inserted: result.inserted, event, analysis });
  });

  app.get('/api/events', async (request) => {
    const query = request.query as { limit?: string };
    return storage.listEvents(Number(query.limit || 100));
  });
  app.get('/api/sessions', async () => storage.listSessions());
  app.get('/api/tasks', async () => storage.listTasks());
  app.get('/api/proxy/requests', async () => storage.listProxyRequests());
  app.get('/api/install/plans', async () => storage.listInstallPlans());

  app.get('/api/inventory', async () => storage.getInventory());
  app.get('/api/inventory/sources', async () => storage.getInventory().sources);
  app.get('/api/inventory/skills', async () => storage.getInventory().skills);
  app.get('/api/inventory/mcp-servers', async () => storage.getInventory().mcpServers);
  app.get('/api/inventory/plugins', async () => storage.getInventory().plugins);
  app.get('/api/inventory/diff', async () => diffInventory(storage.getInventory()));
  app.post('/api/inventory/scan', async () => scanInventory({ workspaceDir, storage }));

  app.get('/api/scan', async () => scan(workspaceDir));
  app.post('/api/install/plan', async (request) => {
    const body = (request.body || {}) as { scope?: 'workspace' | 'user' | 'global'; proxyBaseUrl?: string };
    return planInstall({ workspaceDir, scope: body.scope || 'workspace', proxyBaseUrl: body.proxyBaseUrl, storage });
  });
  app.post('/api/install/apply', async (request) => {
    const body = (request.body || {}) as { planId: string; yes?: boolean };
    const plan = storage.listInstallPlans().find((item) => item.id === body.planId);
    if (!plan) return { ok: false, error: 'plan_not_found' };
    return applyInstall(plan, { yes: body.yes, storage });
  });
  app.post('/api/install/rollback', async () => rollbackLatest({ storage }));

  app.post('/api/notifications/test', async (request) => {
    const body = (request.body || {}) as { channel?: 'webhook' | 'windows'; config?: Record<string, unknown> };
    const result = await sendNotification({
      channel: body.channel || 'webhook',
      title: 'AgentPulse test',
      message: 'Notification channel test from AgentPulse',
      config: body.config
    });
    storage.insertNotification({
      id: newId('notification'),
      channel: result.channel,
      success: result.success,
      title: 'AgentPulse test',
      message: 'Notification channel test from AgentPulse',
      error: result.error
    });
    return result;
  });

  registerProxyRoutes(app, { storage });
  registerStaticWeb(app);

  app.addHook('onClose', async () => storage.close());
  return app;
}

function normalizeHookEvent(integration: string, eventType: AgentEventType, body: Record<string, unknown>): AgentEvent {
  const raw = redactSecrets(body);
  const normalized = {
    ...(body.normalized && typeof body.normalized === 'object' ? (body.normalized as Record<string, unknown>) : {}),
    pid: body.pid,
    title: body.title
  };
  const id = String(body.eventId || body.id || stableId('event', { integration, eventType, body: raw }));
  return {
    id,
    source: integration,
    sourceType: sourceTypeFor(integration),
    eventType,
    timestamp: typeof body.timestamp === 'string' ? body.timestamp : nowIso(),
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
    raw,
    normalized,
    riskLevel: 'none',
    tags: Array.isArray(body.tags) ? body.tags.map(String) : []
  };
}

function sourceTypeFor(integration: string): AgentSourceType {
  if (['codex', 'claude-code', 'opencode'].includes(integration)) return 'ai-coding';
  return 'custom';
}

function shouldNotify(eventType: AgentEventType, riskLevel: string): boolean {
  return eventType === 'permission.request' || eventType === 'error' || eventType === 'session.end' || ['high', 'critical'].includes(riskLevel);
}

function registerStaticWeb(app: FastifyInstance): void {
  const current = dirname(fileURLToPath(import.meta.url));
  const webDist = join(current, '..', '..', 'web', 'dist');
  const clientDist = join(webDist, 'client');
  if (!existsSync(clientDist)) return;
  app.register(fastifyStatic, { root: join(clientDist, 'assets'), prefix: '/assets/' });
  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.raw.url?.startsWith('/api') || request.raw.url?.startsWith('/ingest') || request.raw.url?.startsWith('/proxy')) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    const rendered = await renderSsrPage(webDist, request.raw.url || '/');
    if (rendered) {
      reply.type('text/html').send(rendered);
      return;
    }
    reply.sendFile('index.html');
  });
}

async function renderSsrPage(webDist: string, url: string): Promise<string | null> {
  const templatePath = join(webDist, 'client', 'index.html');
  const serverEntry = join(webDist, 'server', 'entry-server.js');
  if (!existsSync(templatePath) || !existsSync(serverEntry)) return null;
  const template = readFileSync(templatePath, 'utf8');
  const mod = (await import(`${pathToFileURL(serverEntry).href}?t=${Date.now()}`)) as { render?: (url: string) => string | Promise<string> };
  const html = await mod.render?.(url);
  if (!html) return null;
  return template.replace('<!--app-html-->', html);
}
