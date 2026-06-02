import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigRouteState, InstallPlan, newId, nowIso, stableId } from '@agent-pulse/core';
import { createCommandProbe } from '@agent-pulse/probes';
import { buildSources, getPathValue, readJsonLikeConfig, setPathValue, summarizeConfig, targetBackupId } from '../helpers/config.js';
import { normalizeProxyBaseUrl, openAiRouteProfile } from '../helpers/proxy.js';
import { DetectInput, IntegrationAdapter, PlanInstallInput } from '../types.js';

const commandProbe = createCommandProbe();
const endpointFields = ['baseURL', 'baseUrl', 'apiBase', 'endpoint'];

export const openCodeAdapter: IntegrationAdapter = {
  name: 'opencode',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = await commandProbe.which('opencode');
    const routeState = await this.readConfigState(input);
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: false, proxy: true, transcript: false, configInstall: true, rollback: true },
      reasons: [command ? `opencode command found at ${command}` : 'opencode command not found', routeState.routed ? 'OpenCode already routes through AgentPulse' : 'OpenCode route state inspected'],
      warnings: detected ? routeState.warnings : ['OpenCode not detected', ...routeState.warnings],
      routeState
    };
  },
  async getInventorySources(input) {
    return buildSources('opencode', [
      ['workspace', 'tool-config', join(input.workspaceDir, 'opencode.json')],
      ['user', 'tool-config', join(homedir(), '.config', 'opencode', 'config.json')]
    ]);
  },
  async readConfigState(input) {
    return readOpenCodeState(input);
  },
  async planProxyInstall(input) {
    const state = await readOpenCodeState(input);
    const planId = newId('plan');
    const proxyUrl = normalizeProxyBaseUrl(input.proxyBaseUrl, '/proxy/opencode');
    const target = targetPath(input);
    const current = (await readJsonLikeConfig(target)) || {};
    const endpointPath = findOpenCodeEndpointPath(current);
    const actions: InstallPlan['actions'] = [];
    const risks: InstallPlan['risks'] = [];
    if (endpointPath) {
      actions.push({
        type: 'file.patch',
        filePath: target,
        description: 'Route OpenCode default provider traffic through AgentPulse proxy.',
        before: summarizeConfig(current),
        after: setPathValue(current, endpointPath, proxyUrl),
        backupRequired: true,
        scope: input.scope,
        format: 'json',
        writeMode: 'merge',
        preserveFormatting: false
      });
    } else {
      actions.push({
        type: 'command.suggestion',
        command: 'agent-pulse scan',
        reason: 'OpenCode config has multiple or unknown providers; configure the default provider proxy manually.'
      });
      risks.push({ level: 'medium', message: 'OpenCode default provider endpoint was not recognized; no file patch will be applied.' });
    }
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      summary: 'Route OpenCode API-key mode through AgentPulse proxy.',
      preflight: state,
      proxyRoute: this.getProxyRouteProfile(),
      actions,
      risks,
      rollback: { backupId: stableId('backup', { planId }), files: endpointPath ? [{ filePath: target, backupPath: targetBackupId(planId, target) }] : [] },
      verification: { ok: false, checkedFiles: [target], expectedProxyBaseUrl: proxyUrl, warnings: ['Plan has not been applied yet.'] }
    };
  },
  async planInstall(input) {
    return this.planProxyInstall(input);
  },
  async verifyInstall(plan) {
    const expected = plan.verification?.expectedProxyBaseUrl;
    const checkedFiles = plan.actions.filter((action) => action.type === 'file.patch').map((action) => action.filePath);
    const warnings: string[] = [];
    let ok = checkedFiles.length > 0;
    for (const filePath of checkedFiles) {
      const config = await readJsonLikeConfig(filePath);
      const actual = config ? findOpenCodeEndpoint(config) : undefined;
      if (!expected || actual !== expected) {
        ok = false;
        warnings.push(`OpenCode proxy URL was not verified in ${filePath}`);
      }
    }
    return { ok, checkedFiles, expectedProxyBaseUrl: expected, warnings };
  },
  getProxyRouteProfile() {
    return openAiRouteProfile('opencode', '/proxy/opencode');
  }
};

async function readOpenCodeState(input: DetectInput & { scope?: 'workspace' | 'user' | 'global'; proxyBaseUrl?: string }): Promise<AgentConfigRouteState> {
  const target = targetPath({ workspaceDir: input.workspaceDir, scope: input.scope || 'workspace', proxyBaseUrl: input.proxyBaseUrl || 'http://127.0.0.1:8080' });
  const config = await readJsonLikeConfig(target);
  const currentBaseUrl = config ? findOpenCodeEndpoint(config) : undefined;
  const expected = normalizeProxyBaseUrl(input.proxyBaseUrl || 'http://127.0.0.1:8080', '/proxy/opencode');
  const warnings = config ? [] : [`OpenCode config not found or not parseable: ${target}`];
  return {
    integration: 'opencode',
    routed: currentBaseUrl === expected || Boolean(currentBaseUrl?.includes('/proxy/opencode')),
    configPath: target,
    currentBaseUrl,
    originalUpstream: currentBaseUrl?.includes('/proxy/opencode') ? undefined : currentBaseUrl,
    confidence: config ? (currentBaseUrl ? 'high' : 'medium') : 'low',
    warnings,
    summary: config ? summarizeConfig(config) : undefined
  };
}

function targetPath(input: PlanInstallInput): string {
  return input.scope === 'workspace' ? join(input.workspaceDir, 'opencode.json') : join(homedir(), '.config', 'opencode', 'config.json');
}

function findOpenCodeEndpoint(config: Record<string, unknown>): string | undefined {
  const path = findOpenCodeEndpointPath(config);
  const value = path ? getPathValue(config, path) : undefined;
  return typeof value === 'string' ? value : undefined;
}

function findOpenCodeEndpointPath(config: Record<string, unknown>): string[] | undefined {
  for (const field of endpointFields) {
    if (typeof config[field] === 'string') return [field];
  }
  const providers = config.providers;
  const defaultProvider = typeof config.provider === 'string' ? config.provider : typeof config.defaultProvider === 'string' ? config.defaultProvider : undefined;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const entries = Object.entries(providers as Record<string, unknown>);
    const candidate = defaultProvider ? [[defaultProvider, (providers as Record<string, unknown>)[defaultProvider]] as [string, unknown]] : entries.length === 1 ? entries : [];
    for (const [name, raw] of candidate) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      for (const field of endpointFields) {
        if (typeof (raw as Record<string, unknown>)[field] === 'string') return ['providers', name, field];
      }
    }
  }
  if (Array.isArray(providers)) {
    if (providers.length !== 1 && !defaultProvider) return undefined;
    const index = defaultProvider ? providers.findIndex((item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === defaultProvider) : 0;
    const provider = providers[index];
    if (index >= 0 && provider && typeof provider === 'object') {
      for (const field of endpointFields) {
        if (typeof (provider as Record<string, unknown>)[field] === 'string') return ['providers', String(index), field];
      }
    }
  }
  return undefined;
}

