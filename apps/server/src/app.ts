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
  Scope,
  newId,
  nowIso,
  redactSecrets,
  stableId
} from '@agent-pulse/core';
import { getAdapterByName } from '@agent-pulse/integrations';
import { diffInventory, scanInventory } from '@agent-pulse/inventory';
import { applyInstall, planInstall, rollbackIntegration, rollbackLatest, scan } from '@agent-pulse/installer';
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
  app.get('/api/proxy/requests', async (request) => {
    const query = request.query as { limit?: string; sessionId?: string };
    return storage.listProxyRequests(Number(query.limit || 100), {
      sessionId: typeof query.sessionId === 'string' && query.sessionId.trim() ? query.sessionId.trim() : undefined
    });
  });
  app.get('/api/proxy/sessions', async (request) => {
    const query = request.query as { limit?: string };
    return storage.listProxySessions(Number(query.limit || 100));
  });
  app.get('/api/proxy/requests/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const record = storage.getProxyRequest(params.id);
    if (!record) {
      reply.status(404).send({ error: 'proxy_request_not_found', id: params.id });
      return;
    }
    return record;
  });
  app.get('/api/install/plans', async () => storage.listInstallPlans());

  app.get('/api/inventory', async () => storage.getInventory());
  app.get('/api/inventory/sources', async () => storage.getInventory().sources);
  app.get('/api/inventory/skills', async () => storage.getInventory().skills);
  app.get('/api/inventory/mcp-servers', async () => storage.getInventory().mcpServers);
  app.get('/api/inventory/plugins', async () => storage.getInventory().plugins);
  app.get('/api/inventory/diff', async () => diffInventory(storage.getInventory()));
  app.post('/api/inventory/scan', async () => scanInventory({ workspaceDir, storage }));

  app.get('/api/scan', async () => scan(workspaceDir));
  app.post('/api/agents/scan', async (request) => {
    const body = (request.body || {}) as { scope?: Extract<Scope, 'workspace' | 'user'>; proxyBaseUrl?: string };
    return buildAgentRows(storage, await scan(workspaceDir), {
      workspaceDir,
      scope: body.scope || 'user',
      proxyBaseUrl: body.proxyBaseUrl || 'http://127.0.0.1:8080'
    });
  });
  app.post('/api/agents/:integration/replace', async (request) => {
    const params = request.params as { integration: string };
    const body = (request.body || {}) as { scope?: 'workspace' | 'user' | 'global'; proxyBaseUrl?: string; yes?: boolean };
    const scope = body.scope || 'user';
    const plans = await planInstall({ workspaceDir, scope, proxyBaseUrl: body.proxyBaseUrl, storage });
    const plan = plans.find((item) => item.integration === params.integration);
    if (!plan) return { ok: false, error: 'integration_not_found', integration: params.integration };
    const result = await applyInstall(plan, { scope, yes: true, storage });
    return { ok: result.ok, integration: params.integration, plan, result };
  });
  app.post('/api/agents/:integration/rollback', async (request) => {
    const params = request.params as { integration: string };
    const result = rollbackIntegration(params.integration, { storage });
    if (!result.ok && result.restoredFiles.length === 0 && (result.deletedFiles || []).length === 0) {
      return { ok: false, integration: params.integration, error: 'backup_not_found', result };
    }
    return { ok: result.ok, integration: params.integration, result };
  });
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

async function buildAgentRows(
  storage: AgentPulseStorage,
  results: Awaited<ReturnType<typeof scan>>,
  options: { workspaceDir: string; scope: Scope; proxyBaseUrl: string }
) {
  const records = storage.listInstallPlanRecords();
  return Promise.all(results.map(async (result) => {
    const latest = records.find((record) => record.plan.integration === result.integration);
    const latestApplied = records.find((record) => record.plan.integration === result.integration && record.applied);
    const adapter = getAdapterByName(result.integration);
    const routeState = adapter
      ? await adapter.readConfigState({ workspaceDir: options.workspaceDir, scope: options.scope, proxyBaseUrl: options.proxyBaseUrl })
      : result.routeState;
    const proxyRoute = adapter?.getProxyRouteProfile({ proxyBaseUrl: options.proxyBaseUrl });
    const targetSource = result.configSources.find((source) => source.kind === 'tool-config' && source.scope === options.scope);
    const targetConfigPath = routeState?.configPath || targetSource?.path;
    const proxyUrl = proxyRoute ? joinProxyUrl(options.proxyBaseUrl, proxyRoute.localRoute) : undefined;
    const originalUpstream = routeState?.originalUpstream || routeState?.currentBaseUrl || proxyRoute?.defaultUpstream;
    const willCreateConfig = Boolean(targetConfigPath && targetSource && !targetSource.exists);
    const canReplace = result.capabilities.configInstall && Boolean(targetConfigPath);
    return {
      integration: result.integration,
      detected: result.detected,
      sourceType: result.sourceType,
      routeState,
      configSources: result.configSources,
      capabilities: result.capabilities,
      reasons: result.reasons,
      warnings: [...result.warnings, ...(routeState?.warnings || [])],
      latestPlan: latest ? { id: latest.plan.id, applied: latest.applied, appliedAt: latest.appliedAt, scope: latest.plan.scope, summary: latest.plan.summary } : undefined,
      scope: options.scope,
      targetConfigPath,
      originalUpstream,
      proxyBaseUrl: proxyUrl,
      willCreateConfig,
      backupRequired: true,
      canReplace,
      canRollback: Boolean(latestApplied)
    };
  }));
}

function joinProxyUrl(proxyBaseUrl: string, route: string): string {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
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
  const webDist = process.env.AGENT_PULSE_WEB_DIST || join(current, '..', '..', 'web', 'dist');
  const docsDist = process.env.AGENT_PULSE_DOCS_DIST || join(current, '..', '..', 'docs', '.vitepress', 'dist');
  const clientDist = join(webDist, 'client');
  if (existsSync(docsDist)) {
    app.register(fastifyStatic, { root: docsDist, prefix: '/docs/', decorateReply: false });
  }
  if (!existsSync(clientDist)) return;
  app.register(fastifyStatic, { root: join(clientDist, 'assets'), prefix: '/assets/', decorateReply: false });
  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.raw.url?.startsWith('/api') || request.raw.url?.startsWith('/ingest') || request.raw.url?.startsWith('/proxy')) {
      reply.status(404).send({ error: 'not_found' });
      return;
    }
    if (request.raw.url === '/docs') {
      reply.redirect('/docs/');
      return;
    }
    if (process.env.AGENT_PULSE_DISABLE_SSR === '1') {
      reply.type('text/html').send(readFileSync(join(clientDist, 'index.html'), 'utf8'));
      return;
    }
    const rendered = await renderSsrPage(webDist, request.raw.url || '/');
    if (rendered) {
      reply.type('text/html').send(rendered);
      return;
    }
    reply.type('text/html').send(readFileSync(join(clientDist, 'index.html'), 'utf8'));
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
