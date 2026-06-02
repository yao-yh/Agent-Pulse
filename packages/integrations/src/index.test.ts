import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapters, createInstallPlans, scanIntegrations } from './index.js';

describe('integrations', () => {
  it('registers the supported adapters', () => {
    expect(adapters.map((adapter) => adapter.name).sort()).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('plans a Codex TOML proxy patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'config.toml'), 'model_provider = "openai"\n\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\n', 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const codex = plans.find((plan) => plan.integration === 'codex');

    expect(codex?.proxyRoute?.localRoute).toBe('/proxy/codex');
    const action = codex?.actions.find((item) => item.type === 'file.patch');
    expect(action?.filePath).toBe(join(dir, '.codex', 'config.toml'));
    expect(JSON.stringify(action?.after)).toContain('http://127.0.0.1:8080/proxy/codex');
  });

  it('plans a Claude Code JSON patch while preserving hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: ['echo ok'] }, apiBaseUrl: 'https://api.anthropic.com' }), 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const claude = plans.find((plan) => plan.integration === 'claude-code');
    const action = claude?.actions.find((item) => item.type === 'file.patch');

    expect(claude?.proxyRoute?.localRoute).toBe('/proxy/claude-code');
    expect((action?.after as any).hooks.Stop[0]).toBe('echo ok');
    expect((action?.after as any).apiBaseUrl).toBe('http://127.0.0.1:8080/proxy/claude-code');
  });

  it('plans a Claude Code env ANTHROPIC_BASE_URL patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://custom.example', API_TIMEOUT_MS: '3000000' }, model: 'opus' }), 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const claude = plans.find((plan) => plan.integration === 'claude-code');
    const action = claude?.actions.find((item) => item.type === 'file.patch');

    expect(claude?.preflight?.currentBaseUrl).toBe('https://custom.example');
    expect((action?.after as any).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/proxy/claude-code');
    expect((action?.after as any).env.API_TIMEOUT_MS).toBe('3000000');
  });

  it('treats Claude Code without a base URL as official Claude upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { API_TIMEOUT_MS: '3000000' }, model: 'opus' }), 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const claude = plans.find((plan) => plan.integration === 'claude-code');

    expect(claude?.preflight?.currentBaseUrl).toBe('https://api.anthropic.com');
  });

  it('plans an OpenCode default provider patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ defaultProvider: 'openai', providers: { openai: { baseUrl: 'https://api.openai.com/v1' } } }), 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const opencode = plans.find((plan) => plan.integration === 'opencode');
    const action = opencode?.actions.find((item) => item.type === 'file.patch');

    expect(opencode?.proxyRoute?.localRoute).toBe('/proxy/opencode');
    expect((action?.after as any).providers.openai.baseUrl).toBe('http://127.0.0.1:8080/proxy/opencode');
  });

  it('falls back to a suggestion for unknown OpenCode provider schemas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ providers: { a: { baseUrl: 'https://a.example' }, b: { baseUrl: 'https://b.example' } } }), 'utf8');

    const plans = await createInstallPlans({ workspaceDir: dir, scope: 'workspace', proxyBaseUrl: 'http://127.0.0.1:8080' });
    const opencode = plans.find((plan) => plan.integration === 'opencode');

    expect(opencode?.actions.some((item) => item.type === 'file.patch')).toBe(false);
    expect(opencode?.actions.some((item) => item.type === 'command.suggestion')).toBe(true);
  });

  it('includes route state in scan results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pulse-integrations-'));
    const results = await scanIntegrations(dir);
    expect(results.every((item) => item.routeState?.integration === item.integration)).toBe(true);
  });
});
