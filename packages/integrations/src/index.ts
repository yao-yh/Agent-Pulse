import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AgentSourceType,
  InventorySource,
  InstallPlan,
  newId,
  nowIso,
  ScanResult,
  Scope,
  stableId
} from '@agent-pulse/core';
import { createCommandProbe, createFileProbe, sourceId } from '@agent-pulse/probes';

export interface DetectInput {
  workspaceDir: string;
}

export interface PlanInstallInput {
  workspaceDir: string;
  scope: Scope;
  proxyBaseUrl: string;
}

export interface IntegrationAdapter {
  name: string;
  sourceType: AgentSourceType;
  detect(input: DetectInput): Promise<ScanResult>;
  getInventorySources(input: DetectInput): Promise<InventorySource[]>;
  planInstall(input: PlanInstallInput): Promise<InstallPlan>;
}

const fileProbe = createFileProbe();
const commandProbe = createCommandProbe();

export const codexAdapter: IntegrationAdapter = {
  name: 'codex',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = await commandProbe.which('codex');
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: false, proxy: true, transcript: true, configInstall: true, rollback: true },
      reasons: [command ? `codex command found at ${command}` : 'codex command not found'],
      warnings: detected ? [] : ['Codex not detected on this machine']
    };
  },
  async getInventorySources(input) {
    return buildSources('codex', input.workspaceDir, [
      ['workspace', 'tool-config', join(input.workspaceDir, '.codex', 'config.toml')],
      ['workspace', 'skill-dir', join(input.workspaceDir, '.codex', 'skills')],
      ['workspace', 'plugin-dir', join(input.workspaceDir, '.codex', 'plugins')],
      ['user', 'tool-config', join(homedir(), '.codex', 'config.toml')],
      ['user', 'skill-dir', join(homedir(), '.codex', 'skills')],
      ['user', 'plugin-dir', join(homedir(), '.codex', 'plugins')]
    ]);
  },
  async planInstall(input) {
    const planId = newId('plan');
    const target = input.scope === 'workspace' ? join(input.workspaceDir, '.codex', 'agent-pulse.json') : join(homedir(), '.codex', 'agent-pulse.json');
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      actions: [
        {
          type: 'file.patch',
          filePath: target,
          description: 'Write AgentPulse proxy routing metadata for Codex API-key mode.',
          after: {
            proxy: {
              openaiBaseUrl: `${input.proxyBaseUrl.replace(/\/$/, '')}/proxy/codex`,
              note: 'Use this file as AgentPulse metadata; apply concrete Codex config manually if your Codex version needs provider-specific fields.'
            }
          },
          backupRequired: true,
          scope: input.scope
        },
        {
          type: 'command.suggestion',
          command: 'agent-pulse start',
          reason: 'Start local AgentPulse before routing Codex traffic through the proxy.'
        }
      ],
      risks: [{ level: 'low', message: 'Codex config formats differ by version; first install writes metadata and preserves rollback.' }],
      rollback: { backupId: stableId('backup', { planId, target }), files: [{ filePath: target, backupPath: '' }] }
    };
  }
};

export const claudeCodeAdapter: IntegrationAdapter = {
  name: 'claude-code',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = (await commandProbe.which('claude')) || (await commandProbe.which('claude-code'));
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: true, proxy: true, transcript: true, configInstall: true, rollback: true },
      reasons: [command ? `Claude command found at ${command}` : 'Claude command not found'],
      warnings: detected ? [] : ['Claude Code not detected on this machine']
    };
  },
  async getInventorySources(input) {
    return buildSources('claude-code', input.workspaceDir, [
      ['workspace', 'tool-config', join(input.workspaceDir, '.claude', 'settings.json')],
      ['workspace', 'skill-dir', join(input.workspaceDir, '.claude', 'skills')],
      ['workspace', 'plugin-dir', join(input.workspaceDir, '.claude', 'plugins')],
      ['user', 'tool-config', join(homedir(), '.claude', 'settings.json')],
      ['user', 'skill-dir', join(homedir(), '.claude', 'skills')],
      ['user', 'plugin-dir', join(homedir(), '.claude', 'plugins')]
    ]);
  },
  async planInstall(input) {
    const planId = newId('plan');
    const target = input.scope === 'workspace' ? join(input.workspaceDir, '.claude', 'agent-pulse.json') : join(homedir(), '.claude', 'agent-pulse.json');
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      actions: [
        {
          type: 'file.patch',
          filePath: target,
          description: 'Write AgentPulse proxy and hook metadata for Claude Code API-key mode.',
          after: {
            hooks: { endpoint: `${input.proxyBaseUrl.replace(/\/$/, '')}/ingest/hook/claude-code/custom` },
            proxy: { anthropicBaseUrl: `${input.proxyBaseUrl.replace(/\/$/, '')}/proxy/claude-code` }
          },
          backupRequired: true,
          scope: input.scope
        }
      ],
      risks: [{ level: 'medium', message: 'Claude Code hook/settings schema can vary; metadata is backed up and rollbackable.' }],
      rollback: { backupId: stableId('backup', { planId, target }), files: [{ filePath: target, backupPath: '' }] }
    };
  }
};

export const openCodeAdapter: IntegrationAdapter = {
  name: 'opencode',
  sourceType: 'ai-coding',
  async detect(input) {
    const sources = await this.getInventorySources(input);
    const command = await commandProbe.which('opencode');
    const detected = Boolean(command) || sources.some((source) => source.exists);
    return {
      integration: this.name,
      detected,
      sourceType: this.sourceType,
      configSources: sources,
      capabilities: { hook: false, proxy: true, transcript: false, configInstall: false, rollback: false },
      reasons: [command ? `opencode command found at ${command}` : 'OpenCode skeleton only; config install is not supported yet'],
      warnings: detected ? ['OpenCode adapter is detect-only in MVP'] : ['OpenCode not detected']
    };
  },
  async getInventorySources(input) {
    return buildSources('opencode', input.workspaceDir, [
      ['workspace', 'tool-config', join(input.workspaceDir, 'opencode.json')],
      ['user', 'tool-config', join(homedir(), '.config', 'opencode', 'config.json')]
    ]);
  },
  async planInstall(input) {
    const planId = newId('plan');
    return {
      id: planId,
      integration: this.name,
      createdAt: nowIso(),
      scope: input.scope,
      actions: [
        {
          type: 'command.suggestion',
          command: 'agent-pulse scan',
          reason: 'OpenCode install is not implemented in MVP; inspect scan output and configure manually.'
        }
      ],
      risks: [{ level: 'low', message: 'OpenCode adapter is detect-only in this MVP.' }],
      rollback: { backupId: stableId('backup', { planId }), files: [] }
    };
  }
};

export const adapters: IntegrationAdapter[] = [codexAdapter, claudeCodeAdapter, openCodeAdapter];

export async function scanIntegrations(workspaceDir = process.cwd()): Promise<ScanResult[]> {
  return Promise.all(adapters.map((adapter) => adapter.detect({ workspaceDir: resolve(workspaceDir) })));
}

export async function collectIntegrationSources(workspaceDir = process.cwd()): Promise<InventorySource[]> {
  const groups = await Promise.all(adapters.map((adapter) => adapter.getInventorySources({ workspaceDir: resolve(workspaceDir) })));
  return groups.flat();
}

export async function createInstallPlans(input: PlanInstallInput): Promise<InstallPlan[]> {
  return Promise.all(adapters.filter((adapter) => adapter.name !== 'opencode').map((adapter) => adapter.planInstall(input)));
}

async function buildSources(
  integration: string,
  _workspaceDir: string,
  specs: Array<[Scope, InventorySource['kind'], string]>
): Promise<InventorySource[]> {
  return Promise.all(
    specs.map(async ([scope, kind, path]) => {
      const info = await fileProbe.stat(path);
      return {
        id: sourceId(integration, path),
        integration,
        scope,
        kind,
        path,
        exists: Boolean(info),
        lastModifiedAt: info?.lastModifiedAt
      };
    })
  );
}

