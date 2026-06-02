import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigRouteState, InstallPlan, newId, nowIso, stableId } from '@agent-pulse/core';
import { createCommandProbe } from '@agent-pulse/probes';
import { buildSources, getPathValue, readJsonLikeConfig, setPathValue, summarizeConfig, targetBackupId } from '../helpers/config.js';
import { anthropicRouteProfile, normalizeProxyBaseUrl } from '../helpers/proxy.js';
import { DetectInput, IntegrationAdapter, PlanInstallInput } from '../types.js';

const commandProbe = createCommandProbe();
const knownFields = ['ANTHROPIC_BASE_URL', 'apiBaseUrl', 'anthropicBaseUrl'];
const officialClaudeBaseUrl = 'https://api.anthropic.com';

export const claudeCodeAdapter: IntegrationAdapter = {
  name: 'claude-code',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = (await commandProbe.which('claude')) || (await commandProbe.which('claude-code'));
    const routeState = await this.readConfigState(input);
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: true, proxy: true, transcript: true, configInstall: true, rollback: true },
      reasons: [command ? `Claude command found at ${command}` : 'Claude command not found', routeState.routed ? 'Claude Code already routes through AgentPulse' : 'Claude Code route state inspected'],
      warnings: detected ? routeState.warnings : ['Claude Code not detected on this machine', ...routeState.warnings],
      routeState
    };
  },
  async getInventorySources(input) {
    return buildSources('claude-code', [
      ['workspace', 'tool-config', join(input.workspaceDir, '.claude', 'settings.json')],
      ['workspace', 'skill-dir', join(input.workspaceDir, '.claude', 'skills')],
      ['workspace', 'plugin-dir', join(input.workspaceDir, '.claude', 'plugins')],
      ['user', 'tool-config', join(homedir(), '.claude', 'settings.json')],
      ['user', 'skill-dir', join(homedir(), '.claude', 'skills')],
      ['user', 'plugin-dir', join(homedir(), '.claude', 'plugins')]
    ]);
  },
  async readConfigState(input) {
    return readClaudeState(input);
  },
  async planProxyInstall(input) {
    const state = await readClaudeState(input);
    const planId = newId('plan');
    const proxyUrl = normalizeProxyBaseUrl(input.proxyBaseUrl, '/proxy/claude-code');
    const target = targetPath(input);
    const current = (await readJsonLikeConfig(target)) || {};
    const baseUrlPath = findClaudeBaseUrlPath(current) || ['env', 'ANTHROPIC_BASE_URL'];
    const after = setPathValue(current, baseUrlPath, proxyUrl);
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      summary: 'Route Claude Code API-key mode through AgentPulse proxy.',
      preflight: state,
      proxyRoute: this.getProxyRouteProfile(),
      actions: [
        {
          type: 'file.patch',
          filePath: target,
          description: 'Route Claude Code Anthropic-compatible traffic through AgentPulse proxy.',
          before: summarizeConfig(current),
          after,
          backupRequired: true,
          scope: input.scope,
          format: 'json',
          writeMode: 'merge',
          preserveFormatting: false
        }
      ],
      risks: [{ level: 'low', message: 'Claude Code settings schema can vary; unknown fields are preserved and rollback is available.' }],
      rollback: { backupId: stableId('backup', { planId }), files: [{ filePath: target, backupPath: targetBackupId(planId, target) }] },
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
      const actual = config ? findClaudeBaseUrl(config) : undefined;
      if (!expected || actual !== expected) {
        ok = false;
        warnings.push(`Claude Code proxy URL was not verified in ${filePath}`);
      }
    }
    return { ok, checkedFiles, expectedProxyBaseUrl: expected, warnings };
  },
  getProxyRouteProfile() {
    return anthropicRouteProfile('claude-code', '/proxy/claude-code');
  }
};

async function readClaudeState(input: DetectInput & { scope?: 'workspace' | 'user' | 'global'; proxyBaseUrl?: string }): Promise<AgentConfigRouteState> {
  const target = targetPath({ workspaceDir: input.workspaceDir, scope: input.scope || 'workspace', proxyBaseUrl: input.proxyBaseUrl || 'http://127.0.0.1:8080' });
  const config = await readJsonLikeConfig(target);
  const currentBaseUrl = config ? findClaudeBaseUrl(config) || officialClaudeBaseUrl : undefined;
  const expected = normalizeProxyBaseUrl(input.proxyBaseUrl || 'http://127.0.0.1:8080', '/proxy/claude-code');
  const warnings = config ? [] : [`Claude Code config not found or not parseable: ${target}`];
  return {
    integration: 'claude-code',
    routed: currentBaseUrl === expected || Boolean(currentBaseUrl?.includes('/proxy/claude-code')),
    configPath: target,
    currentBaseUrl,
    originalUpstream: currentBaseUrl?.includes('/proxy/claude-code') ? undefined : currentBaseUrl,
    confidence: config ? (currentBaseUrl ? 'high' : 'medium') : 'low',
    warnings,
    summary: config ? summarizeConfig(config) : undefined
  };
}

function targetPath(input: PlanInstallInput): string {
  return input.scope === 'workspace' ? join(input.workspaceDir, '.claude', 'settings.json') : join(homedir(), '.claude', 'settings.json');
}

function findClaudeBaseUrl(config: Record<string, unknown>): string | undefined {
  const envValue = getPathValue(config, ['env', 'ANTHROPIC_BASE_URL']);
  if (typeof envValue === 'string') return envValue;
  for (const field of knownFields) {
    if (typeof config[field] === 'string') return config[field] as string;
  }
  return undefined;
}

function findClaudeBaseUrlPath(config: Record<string, unknown>): string[] | undefined {
  if (typeof getPathValue(config, ['env', 'ANTHROPIC_BASE_URL']) === 'string') return ['env', 'ANTHROPIC_BASE_URL'];
  for (const field of knownFields) {
    if (typeof config[field] === 'string') return [field];
  }
  return undefined;
}
