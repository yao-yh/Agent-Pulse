import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigRouteState, InstallPlan, InstallVerification, newId, nowIso, stableId } from '@agent-pulse/core';
import { createCommandProbe } from '@agent-pulse/probes';
import {
  buildSources,
  getPathValue,
  readTomlConfig,
  setPathValue,
  summarizeConfig,
  targetBackupId
} from '../helpers/config.js';
import { normalizeProxyBaseUrl, openAiRouteProfile } from '../helpers/proxy.js';
import { DetectInput, IntegrationAdapter, PlanInstallInput } from '../types.js';

const commandProbe = createCommandProbe();

export const codexAdapter: IntegrationAdapter = {
  name: 'codex',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = await commandProbe.which('codex');
    const routeState = await this.readConfigState(input);
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: false, proxy: true, transcript: true, configInstall: true, rollback: true },
      reasons: [command ? `codex command found at ${command}` : 'codex command not found', routeState.routed ? 'Codex already routes through AgentPulse' : 'Codex route state inspected'],
      warnings: detected ? routeState.warnings : ['Codex not detected on this machine', ...routeState.warnings],
      routeState
    };
  },
  async getInventorySources(input) {
    return buildSources('codex', [
      ['workspace', 'tool-config', join(input.workspaceDir, '.codex', 'config.toml')],
      ['workspace', 'skill-dir', join(input.workspaceDir, '.codex', 'skills')],
      ['workspace', 'plugin-dir', join(input.workspaceDir, '.codex', 'plugins')],
      ['user', 'tool-config', join(homedir(), '.codex', 'config.toml')],
      ['user', 'skill-dir', join(homedir(), '.codex', 'skills')],
      ['user', 'plugin-dir', join(homedir(), '.codex', 'plugins')]
    ]);
  },
  async readConfigState(input) {
    return readCodexState(input);
  },
  async planProxyInstall(input) {
    const state = await readCodexState(input);
    const planId = newId('plan');
    const proxyUrl = normalizeProxyBaseUrl(input.proxyBaseUrl, '/proxy/codex');
    const target = targetPath(input);
    const current = (await readTomlConfig(target)) || {};
    const writablePath = findCodexBaseUrlPath(current);
    const actions: InstallPlan['actions'] = [];
    const risks: InstallPlan['risks'] = [];
    const after = writablePath ? setPathValue(current, writablePath, proxyUrl) : current;

    if (writablePath) {
      actions.push({
        type: 'file.patch',
        filePath: target,
        description: 'Route Codex API-key mode traffic through AgentPulse proxy.',
        before: summarizeConfig(current),
        after,
        backupRequired: true,
        scope: input.scope,
        format: 'toml',
        writeMode: 'structured-patch',
        preserveFormatting: false
      });
    } else {
      actions.push({
        type: 'command.suggestion',
        command: 'agent-pulse scan',
        reason: 'Codex config schema does not expose a known base_url field; inspect config and configure proxy manually.'
      });
      risks.push({ level: 'medium', message: 'Codex config schema was not recognized; no file patch will be applied.' });
    }

    actions.push({ type: 'command.suggestion', command: 'agent-pulse start', reason: 'Start local AgentPulse before routing Codex traffic through the proxy.' });
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      summary: 'Route Codex API-key mode through AgentPulse proxy.',
      preflight: state,
      proxyRoute: this.getProxyRouteProfile(),
      actions,
      risks,
      rollback: { backupId: stableId('backup', { planId }), files: writablePath ? [{ filePath: target, backupPath: targetBackupId(planId, target) }] : [] },
      verification: { ok: false, checkedFiles: [target], expectedProxyBaseUrl: proxyUrl, warnings: ['Plan has not been applied yet.'] }
    };
  },
  async planInstall(input) {
    return this.planProxyInstall(input);
  },
  async verifyInstall(plan) {
    const expected = plan.verification?.expectedProxyBaseUrl || plan.proxyRoute?.localRoute;
    const checkedFiles = plan.actions.filter((action) => action.type === 'file.patch').map((action) => action.filePath);
    const warnings: string[] = [];
    let ok = checkedFiles.length > 0;
    for (const filePath of checkedFiles) {
      const config = await readTomlConfig(filePath);
      const actual = config ? findCodexBaseUrl(config) : undefined;
      if (!expected || actual !== expected) {
        ok = false;
        warnings.push(`Codex proxy URL was not verified in ${filePath}`);
      }
    }
    return { ok, checkedFiles, expectedProxyBaseUrl: expected, warnings };
  },
  getProxyRouteProfile() {
    return openAiRouteProfile('codex', '/proxy/codex');
  }
};

async function readCodexState(input: DetectInput & { scope?: 'workspace' | 'user' | 'global'; proxyBaseUrl?: string }): Promise<AgentConfigRouteState> {
  const target = targetPath({ workspaceDir: input.workspaceDir, scope: input.scope || 'workspace', proxyBaseUrl: input.proxyBaseUrl || 'http://127.0.0.1:8080' });
  const config = await readTomlConfig(target);
  const currentBaseUrl = config ? findCodexBaseUrl(config) : undefined;
  const expected = normalizeProxyBaseUrl(input.proxyBaseUrl || 'http://127.0.0.1:8080', '/proxy/codex');
  const warnings = config ? [] : [`Codex config not found or not parseable: ${target}`];
  return {
    integration: 'codex',
    routed: currentBaseUrl === expected || Boolean(currentBaseUrl?.includes('/proxy/codex')),
    configPath: target,
    currentBaseUrl,
    originalUpstream: currentBaseUrl?.includes('/proxy/codex') ? undefined : currentBaseUrl,
    confidence: config ? (currentBaseUrl ? 'high' : 'medium') : 'low',
    warnings,
    summary: config ? summarizeConfig(config) : undefined
  };
}

function targetPath(input: PlanInstallInput): string {
  return input.scope === 'workspace' ? join(input.workspaceDir, '.codex', 'config.toml') : join(homedir(), '.codex', 'config.toml');
}

function findCodexBaseUrl(config: Record<string, unknown>): string | undefined {
  const path = findCodexBaseUrlPath(config);
  const value = path ? getPathValue(config, path) : undefined;
  return typeof value === 'string' ? value : undefined;
}

function findCodexBaseUrlPath(config: Record<string, unknown>): string[] | undefined {
  if (typeof config.base_url === 'string') return ['base_url'];
  const providerName = typeof config.model_provider === 'string' ? config.model_provider : undefined;
  for (const groupName of ['model_providers', 'providers']) {
    const group = config[groupName];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    if (providerName) {
      const provider = (group as Record<string, unknown>)[providerName];
      if (provider && typeof provider === 'object' && !Array.isArray(provider) && typeof (provider as Record<string, unknown>).base_url === 'string') {
        return [groupName, providerName, 'base_url'];
      }
    }
    for (const [name, raw] of Object.entries(group as Record<string, unknown>)) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).base_url === 'string') {
        return [groupName, name, 'base_url'];
      }
    }
  }
  return undefined;
}

