import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyInstall, planInstall, rollbackLatest } from './index.js';
import { createStorage } from '@agent-pulse/storage';

describe('installer', () => {
  const oldDataDir = process.env.AGENT_PULSE_DATA_DIR;

  afterEach(() => {
    if (oldDataDir === undefined) delete process.env.AGENT_PULSE_DATA_DIR;
    else process.env.AGENT_PULSE_DATA_DIR = oldDataDir;
  });

  it('plans without modifying files, applies with backup metadata, and rolls back existing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-installer-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const settings = join(dir, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ apiBaseUrl: 'https://api.anthropic.com', hooks: { Stop: ['echo ok'] } }), 'utf8');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });

    const before = readFileSync(settings, 'utf8');
    const plans = await planInstall({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080', storage });
    expect(readFileSync(settings, 'utf8')).toBe(before);

    const claude = plans.find((plan) => plan.integration === 'claude-code');
    expect(claude).toBeTruthy();
    const result = await applyInstall(claude!, { storage });
    expect(result.ok).toBe(true);
    expect(result.verification?.ok).toBe(true);
    expect(readFileSync(settings, 'utf8')).toContain('/proxy/claude-code');
    expect(storage.getProxyRouteMapping('claude-code')?.upstreamBaseUrl).toBe('https://api.anthropic.com');

    const backups = storage.getLatestBackups();
    expect(existsSync(backups[0]!.backupPath)).toBe(true);
    expect(existsSync(`${backups[0]!.backupPath}.meta.json`)).toBe(true);

    const rollback = rollbackLatest({ storage });
    expect(rollback.ok).toBe(true);
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(storage.getProxyRouteMapping('claude-code')).toBeUndefined();
    storage.close();
  });

  it('persists custom Claude upstream mappings and removes them on integration rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-installer-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const settings = join(dir, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://custom.example' } }), 'utf8');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });

    const plans = await planInstall({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080', storage });
    const claude = plans.find((plan) => plan.integration === 'claude-code');
    const result = await applyInstall(claude!, { storage });
    expect(result.ok).toBe(true);
    expect(storage.getProxyRouteMapping('claude-code')?.upstreamBaseUrl).toBe('https://custom.example');

    const rollback = rollbackLatest({ storage });
    expect(rollback.ok).toBe(true);
    expect(storage.getProxyRouteMapping('claude-code')).toBeUndefined();
    storage.close();
  });

  it('deletes files that were created by apply when rolling back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-installer-'));
    process.env.AGENT_PULSE_DATA_DIR = join(dir, 'data');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const settings = join(dir, '.claude', 'settings.json');
    const storage = createStorage({ databasePath: join(dir, 'test.db') });

    const plans = await planInstall({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080', storage });
    const claude = plans.find((plan) => plan.integration === 'claude-code');
    const result = await applyInstall(claude!, { storage });
    expect(result.ok).toBe(true);
    expect(existsSync(settings)).toBe(true);

    const rollback = rollbackLatest({ storage });
    expect(rollback.ok).toBe(true);
    expect(rollback.deletedFiles).toContain(settings);
    expect(existsSync(settings)).toBe(false);
    storage.close();
  });
});
