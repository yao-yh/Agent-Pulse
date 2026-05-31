import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from '@agent-pulse/storage';
import { buildApp } from './app';

describe('server app', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
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
});

