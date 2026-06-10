import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from '@agent-pulse/storage';
import { buildApp } from './app';

describe('server app', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const oldDataDir = process.env.AGENT_PULSE_DATA_DIR;
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
    if (oldDataDir === undefined) delete process.env.AGENT_PULSE_DATA_DIR;
    else process.env.AGENT_PULSE_DATA_DIR = oldDataDir;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
  });

  it('serves health and ingests hook events idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const payload = { eventId: 'evt_test', sessionId: 's1', title: 'hello' };
    const first = await app.inject({ method: 'POST', url: '/ingest/hook/codex/session.start', payload });
    const second = await app.inject({ method: 'POST', url: '/ingest/hook/codex/session.start', payload });
    expect(first.statusCode).toBe(200);
    expect(second.json().inserted).toBe(false);
    expect(storage.listEvents()).toHaveLength(1);
    expect(storage.listTasks()[0]?.status).toBe('running');
  });

  it('scans, replaces, and rolls back a selected agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const claudeConfig = join(dir, '.claude', 'settings.json');
    const codexConfig = join(dir, '.codex', 'config.toml');
    writeFileSync(claudeConfig, JSON.stringify({ apiBaseUrl: 'https://api.anthropic.com' }), 'utf8');
    writeFileSync(codexConfig, 'base_url = "https://api.openai.com/v1"\n', 'utf8');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const scan = await app.inject({ method: 'POST', url: '/api/agents/scan', payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().map((row: any) => row.integration)).toContain('claude-code');

    const replace = await app.inject({
      method: 'POST',
      url: '/api/agents/claude-code/replace',
      payload: { scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' }
    });
    expect(replace.statusCode).toBe(200);
    expect(replace.json().ok).toBe(true);
    expect(readFileSync(claudeConfig, 'utf8')).toContain('/proxy/claude-code');
    expect(readFileSync(codexConfig, 'utf8')).toContain('https://api.openai.com/v1');

    const rollback = await app.inject({ method: 'POST', url: '/api/agents/claude-code/rollback', payload: {} });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().ok).toBe(true);
    expect(readFileSync(claudeConfig, 'utf8')).toContain('https://api.anthropic.com');
    expect(existsSync(codexConfig)).toBe(true);
  });

  it('does not rollback another agent when selected agent has no backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const rollback = await app.inject({ method: 'POST', url: '/api/agents/codex/rollback', payload: {} });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().ok).toBe(false);
    expect(rollback.json().error).toBe('backup_not_found');
  });

  it('returns proxy request context details by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    storage.insertProxyRequest({
      id: 'proxy_detail_test',
      provider: 'claude-code',
      proxyKey: 'claude-code',
      apiProtocol: 'anthropic-compatible',
      sessionId: 'session-detail',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      statusCode: 200,
      durationMs: 12,
      requestSummary: { value: { body: { message: 'hello', token: '<redacted>' } }, truncated: false },
      responseSummary: { value: { ok: true }, truncated: false },
      createdAt: '2026-06-04T00:00:00.000Z'
    });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const detail = await app.inject({ method: 'GET', url: '/api/proxy/requests/proxy_detail_test' });
    const missing = await app.inject({ method: 'GET', url: '/api/proxy/requests/missing' });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: 'proxy_detail_test',
      proxyKey: 'claude-code',
      apiProtocol: 'anthropic-compatible',
      sessionId: 'session-detail',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      requestSummary: { value: { body: { message: 'hello', token: '<redacted>' } } }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'proxy_request_not_found', id: 'missing' });
  });

  it('filters proxy requests by session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    storage.insertProxyRequest({
      id: 'proxy_session_a',
      provider: 'claude-code',
      sessionId: 'session-a',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      createdAt: '2026-06-04T00:00:00.000Z'
    });
    storage.insertProxyRequest({
      id: 'proxy_session_b',
      provider: 'claude-code',
      sessionId: 'session-b',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      createdAt: '2026-06-04T00:00:01.000Z'
    });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/proxy/requests?sessionId=session-a' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ id: 'proxy_session_a', sessionId: 'session-a' }]);
  });

  it('returns proxy session summaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    storage.insertProxyRequest({
      id: 'proxy_session_summary_a1',
      provider: 'claude-code',
      sessionId: 'session-summary-a',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      statusCode: 200,
      createdAt: '2026-06-04T00:00:00.000Z'
    });
    storage.insertProxyRequest({
      id: 'proxy_session_summary_a2',
      provider: 'claude-code',
      sessionId: 'session-summary-a',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages/latest',
      upstreamUrl: 'https://api.anthropic.com/v1/messages/latest',
      statusCode: 500,
      error: 'upstream_failed',
      createdAt: '2026-06-04T00:00:01.000Z'
    });
    storage.insertProxyRequest({
      id: 'proxy_session_summary_no_session',
      provider: 'claude-code',
      method: 'POST',
      path: '/proxy/claude-code/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      createdAt: '2026-06-04T00:00:02.000Z'
    });
    const app = await buildApp({ storage, workspaceDir: dir });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/proxy/sessions' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: 'session-summary-a',
        provider: 'claude-code',
        requestCount: 2,
        errorCount: 1,
        latestStatusCode: 500,
        latestPath: '/proxy/claude-code/v1/messages/latest'
      }
    ]);
  });

  it('scans and replaces Claude Code user config from the agents page flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const claudeConfig = join(dir, '.claude', 'settings.json');
    writeFileSync(claudeConfig, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://inai.inchtek.online', API_TIMEOUT_MS: '3000000' }, model: 'opus' }), 'utf8');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const app = await buildApp({ storage, workspaceDir: join(dir, 'workspace') });
    apps.push(app);

    const scan = await app.inject({ method: 'POST', url: '/api/agents/scan', payload: { scope: 'user', proxyBaseUrl: 'http://127.0.0.1:8080' } });
    const claudeRow = scan.json().find((row: any) => row.integration === 'claude-code');
    expect(claudeRow.targetConfigPath).toBe(claudeConfig);
    expect(claudeRow.originalUpstream).toBe('https://inai.inchtek.online');

    const replace = await app.inject({
      method: 'POST',
      url: '/api/agents/claude-code/replace',
      payload: { scope: 'user', proxyBaseUrl: 'http://127.0.0.1:8080' }
    });
    expect(replace.json().ok).toBe(true);
    const replaced = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    expect(replaced.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/proxy/claude-code');
    expect(replaced.env.API_TIMEOUT_MS).toBe('3000000');
    expect(storage.getProxyRouteMapping('claude-code')?.upstreamBaseUrl).toBe('https://inai.inchtek.online');
  });

  it('adds Claude Code user env base URL and removes route mapping on rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const claudeConfig = join(dir, '.claude', 'settings.json');
    writeFileSync(claudeConfig, JSON.stringify({ env: { API_TIMEOUT_MS: '3000000' }, theme: 'auto' }), 'utf8');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });
    const app = await buildApp({ storage, workspaceDir: join(dir, 'workspace') });
    apps.push(app);

    const replace = await app.inject({
      method: 'POST',
      url: '/api/agents/claude-code/replace',
      payload: { scope: 'user', proxyBaseUrl: 'http://127.0.0.1:8080' }
    });
    expect(replace.json().ok).toBe(true);
    expect(JSON.parse(readFileSync(claudeConfig, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/proxy/claude-code');
    expect(storage.getProxyRouteMapping('claude-code')?.upstreamBaseUrl).toBe('https://api.anthropic.com');

    const rollback = await app.inject({ method: 'POST', url: '/api/agents/claude-code/rollback', payload: {} });
    expect(rollback.json().ok).toBe(true);
    const restored = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    expect(restored.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(restored.env.API_TIMEOUT_MS).toBe('3000000');
    expect(storage.getProxyRouteMapping('claude-code')).toBeUndefined();
  });
});

