import { join } from 'node:path';
import {
  InventorySnapshot,
  McpServerInventoryItem,
  nowIso,
  PluginInventoryItem,
  SkillInventoryItem,
  stableId
} from '@agent-pulse/core';
import { collectIntegrationSources } from '@agent-pulse/integrations';
import { createConfigProbe, createFileProbe, createMcpProbe, createSkillProbe } from '@agent-pulse/probes';
import { AgentPulseStorage } from '@agent-pulse/storage';

export interface InventoryScanOptions {
  workspaceDir?: string;
  storage?: AgentPulseStorage;
}

export async function scanInventory(options: InventoryScanOptions = {}): Promise<InventorySnapshot> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const sources = await collectIntegrationSources(workspaceDir);
  const fileProbe = createFileProbe();
  const skillProbe = createSkillProbe();
  const configProbe = createConfigProbe();
  const mcpProbe = createMcpProbe();
  const skills: SkillInventoryItem[] = [];
  const mcpServers: McpServerInventoryItem[] = [];
  const plugins: PluginInventoryItem[] = [];

  for (const source of sources) {
    if (!source.exists) continue;
    if (source.kind === 'skill-dir') {
      const entries = await fileProbe.listDir(source.path);
      for (const entry of entries.filter((item) => item.isDirectory)) {
        const probe = await skillProbe.isSkillDirectory(entry.path);
        if (!probe.isSkill) continue;
        const info = await fileProbe.stat(entry.path);
        skills.push({
          id: stableId('skill', { source: source.path, dir: entry.path }),
          name: probe.name || entry.name,
          description: probe.description,
          integration: source.integration,
          scope: source.scope,
          directory: entry.path,
          entryFile: probe.entryFile,
          enabled: true,
          sourcePath: source.path,
          lastModifiedAt: info?.lastModifiedAt,
          status: 'discovered'
        });
      }
    }
    if (source.kind === 'plugin-dir') {
      const entries = await fileProbe.listDir(source.path);
      for (const entry of entries.filter((item) => item.isDirectory)) {
        const manifestPath = (await fileProbe.exists(join(entry.path, 'package.json')))
          ? join(entry.path, 'package.json')
          : (await fileProbe.exists(join(entry.path, 'manifest.json')))
            ? join(entry.path, 'manifest.json')
            : undefined;
        const info = await fileProbe.stat(entry.path);
        plugins.push({
          id: stableId('plugin', { source: source.path, dir: entry.path }),
          name: entry.name,
          integration: source.integration,
          scope: source.scope,
          directory: entry.path,
          manifestPath,
          enabled: true,
          sourcePath: source.path,
          lastModifiedAt: info?.lastModifiedAt,
          status: manifestPath ? 'discovered' : 'configured'
        });
      }
    }
    if (source.kind === 'tool-config') {
      const parsed = source.path.endsWith('.toml')
        ? await configProbe.parseToml(source.path)
        : source.path.endsWith('.json') || source.path.endsWith('.jsonc')
          ? await configProbe.parseJsonc(source.path)
          : { ok: false as const };
      if (!parsed.ok) continue;
      for (const candidate of mcpProbe.extractMcpServers(parsed.value, source.path)) {
        mcpServers.push({
          id: stableId('mcp', { source: source.path, name: candidate.name }),
          name: candidate.name,
          integration: source.integration,
          scope: source.scope,
          transport: candidate.transport,
          command: candidate.command,
          args: candidate.args,
          url: candidate.url,
          envKeys: candidate.envKeys,
          enabled: true,
          sourcePath: source.path,
          lastModifiedAt: source.lastModifiedAt,
          riskLevel: candidate.riskLevel,
          status: candidate.command || candidate.url ? 'configured' : 'discovered'
        });
      }
    }
  }

  const snapshot = { sources, skills, mcpServers, plugins, scannedAt: nowIso() };
  options.storage?.upsertInventory(snapshot);
  return snapshot;
}

export function diffInventory(snapshot: InventorySnapshot): Array<{ type: string; message: string; sourcePath?: string }> {
  const findings: Array<{ type: string; message: string; sourcePath?: string }> = [];
  for (const source of snapshot.sources) {
    if (!source.exists) findings.push({ type: 'missing-source', message: `${source.integration} ${source.kind} missing`, sourcePath: source.path });
  }
  for (const server of snapshot.mcpServers) {
    if (!server.command && !server.url) {
      findings.push({ type: 'configured-but-missing', message: `MCP server ${server.name} has no command or url`, sourcePath: server.sourcePath });
    }
  }
  return findings;
}

