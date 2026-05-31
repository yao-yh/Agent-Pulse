import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, platform, release, type } from 'node:os';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  isSensitiveKey,
  McpTransport,
  ProbeResult,
  redactSecrets,
  RiskLevel,
  stableId
} from '@agent-pulse/core';

export interface FileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileStat {
  path: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  lastModifiedAt: string;
}

export interface SkillProbeResult {
  isSkill: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  entryFile?: string;
  name?: string;
  description?: string;
}

export interface McpServerCandidate {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  sourcePath?: string;
  confidence: 'low' | 'medium' | 'high';
  riskLevel: RiskLevel;
}

export function createSystemProbe(workspaceDir = process.cwd()) {
  return {
    getPlatform: () => ({ platform: platform(), release: release(), type: type(), arch: process.arch }),
    getHomeDir: () => homedir(),
    getWorkspaceDir: () => resolve(workspaceDir),
    getConfigDirs: () => [
      { scope: 'workspace' as const, path: resolve(workspaceDir) },
      { scope: 'user' as const, path: homedir() }
    ]
  };
}

export function createFileProbe() {
  return {
    async exists(path: string): Promise<boolean> {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path: string): Promise<FileStat | null> {
      try {
        const result = await stat(path);
        return {
          path,
          size: result.size,
          isDirectory: result.isDirectory(),
          isFile: result.isFile(),
          lastModifiedAt: result.mtime.toISOString()
        };
      } catch {
        return null;
      }
    },
    async listDir(path: string): Promise<FileEntry[]> {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({
          path: join(path, entry.name),
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile()
        }));
      } catch {
        return [];
      }
    },
    async readText(path: string, maxBytes = 256 * 1024): Promise<string> {
      const info = await stat(path);
      if (info.size > maxBytes) throw new Error(`Refusing to read large file: ${path}`);
      return readFile(path, 'utf8');
    }
  };
}

export function createCommandProbe() {
  return {
    async which(command: string): Promise<string | null> {
      const names = process.platform === 'win32' && !/\.(exe|cmd|bat|ps1)$/i.test(command)
        ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`]
        : [command];
      for (const dir of (process.env.PATH || '').split(delimiter)) {
        for (const name of names) {
          const candidate = join(dir, name);
          try {
            await access(candidate, constants.X_OK);
            return candidate;
          } catch {
            try {
              await access(candidate, constants.F_OK);
              return candidate;
            } catch {
              // continue
            }
          }
        }
      }
      return null;
    },
    async getVersion(command: string, args = ['--version']): Promise<{ ok: boolean; output?: string; error?: string }> {
      return new Promise((resolveResult) => {
        const child = spawn(command, args, { shell: true, windowsHide: true });
        let output = '';
        let error = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (error += String(chunk)));
        child.on('error', (err) => resolveResult({ ok: false, error: err.message }));
        child.on('close', (code) => resolveResult({ ok: code === 0, output: output.trim() || error.trim(), error: code === 0 ? undefined : error.trim() }));
      });
    },
    async isExecutable(path: string): Promise<boolean> {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
  };
}

export function createConfigProbe() {
  return {
    async parseJson(path: string): Promise<ProbeResult<unknown>> {
      return parseConfig(path, (text) => JSON.parse(text));
    },
    async parseJsonc(path: string): Promise<ProbeResult<unknown>> {
      return parseConfig(path, (text) => JSON.parse(stripJsonComments(text)));
    },
    async parseToml(path: string): Promise<ProbeResult<Record<string, unknown>>> {
      return parseConfig(path, parseSimpleToml);
    },
    async parseYaml(path: string): Promise<ProbeResult<Record<string, unknown>>> {
      return parseConfig(path, parseSimpleYaml);
    }
  };
}

export function createSkillProbe() {
  const fileProbe = createFileProbe();
  return {
    async isSkillDirectory(path: string): Promise<SkillProbeResult> {
      const entryFile = join(path, 'SKILL.md');
      if (!(await fileProbe.exists(entryFile))) {
        return { isSkill: false, confidence: 'low', reasons: ['SKILL.md not found'] };
      }
      const metadata = await this.readSkillMetadata(path);
      return {
        isSkill: true,
        confidence: 'high',
        reasons: ['SKILL.md found'],
        entryFile,
        name: metadata.value?.name,
        description: metadata.value?.description
      };
    },
    async readSkillMetadata(path: string): Promise<ProbeResult<{ name: string; description?: string; entryFile: string }>> {
      const entryFile = join(path, 'SKILL.md');
      try {
        const text = await fileProbe.readText(entryFile, 128 * 1024);
        const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const description = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#') && !line.startsWith('---'));
        return {
          ok: true,
          confidence: 'high',
          value: { name: heading || dirname(path).split(/[\\/]/).pop() || path, description, entryFile },
          reasons: ['Read SKILL.md metadata']
        };
      } catch (error) {
        return { ok: false, errors: [{ code: 'skill.read_failed', message: String(error), path: entryFile }] };
      }
    }
  };
}

export function createMcpProbe() {
  return {
    isMcpConfig(value: unknown): ProbeResult<boolean> {
      const servers = this.extractMcpServers(value);
      return { ok: true, value: servers.length > 0, confidence: servers.length > 0 ? 'high' : 'low' };
    },
    extractMcpServers(config: unknown, sourcePath?: string): McpServerCandidate[] {
      const root = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
      const serverMap = findServerMap(root);
      return Object.entries(serverMap).map(([name, raw]) => {
        const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const url = stringValue(item.url) || stringValue(item.endpoint);
        const command = stringValue(item.command);
        const env = item.env && typeof item.env === 'object' ? (item.env as Record<string, unknown>) : {};
        const envKeys = Object.keys(env);
        return {
          name,
          transport: detectTransport(item, url, command),
          command,
          args: Array.isArray(item.args) ? item.args.map(String) : undefined,
          url,
          envKeys,
          sourcePath,
          confidence: command || url ? 'high' : 'medium',
          riskLevel: envKeys.some(isSensitiveKey) ? 'medium' : 'none'
        };
      });
    }
  };
}

export function createSecretProbe() {
  return {
    isSensitiveKey,
    containsSecret(value: string) {
      const findings = [];
      if (/(sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|Bearer\s+[a-zA-Z0-9._-]{16,})/.test(value)) {
        findings.push({ code: 'secret.pattern', message: 'Sensitive token-like value detected' });
      }
      return findings;
    },
    redactValue(value: unknown) {
      return redactSecrets(value);
    },
    redactObject(value: unknown) {
      return redactSecrets(value);
    }
  };
}

export function createProcessProbe() {
  return {
    async isAlive(pid: number): Promise<boolean> {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async describe(pid: number): Promise<{ pid: number; alive: boolean } | null> {
      const alive = await this.isAlive(pid);
      return alive ? { pid, alive } : null;
    }
  };
}

export const probes = {
  system: createSystemProbe(),
  file: createFileProbe(),
  command: createCommandProbe(),
  config: createConfigProbe(),
  skill: createSkillProbe(),
  mcp: createMcpProbe(),
  secret: createSecretProbe(),
  process: createProcessProbe()
};

async function parseConfig<T>(path: string, parser: (text: string) => T): Promise<ProbeResult<T>> {
  try {
    const text = await createFileProbe().readText(path);
    return { ok: true, value: parser(text), confidence: 'high', reasons: [`Parsed ${extname(path) || 'config'} file`] };
  } catch (error) {
    return { ok: false, errors: [{ code: 'config.parse_failed', message: String(error), path }] };
  }
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function parseSimpleToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[(.+)]$/)?.[1];
    if (section) {
      current = root;
      for (const part of section.split('.').map((item) => item.replace(/^["']|["']$/g, ''))) {
        current[part] = current[part] && typeof current[part] === 'object' ? current[part] : {};
        current = current[part] as Record<string, unknown>;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    current[line.slice(0, eq).trim()] = parseScalar(line.slice(eq + 1).trim());
  }
  return root;
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes(':')) continue;
    const [key, ...rest] = line.split(':');
    if (key) root[key.trim()] = parseScalar(rest.join(':').trim());
  }
  return root;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item.trim()));
  }
  return trimmed;
}

function findServerMap(root: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    root.mcp_servers,
    root.mcpServers,
    root.servers,
    root.mcp && typeof root.mcp === 'object' ? (root.mcp as Record<string, unknown>).servers : undefined
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function detectTransport(item: Record<string, unknown>, url?: string, command?: string): McpTransport {
  const explicit = stringValue(item.transport);
  if (explicit === 'stdio' || explicit === 'http' || explicit === 'sse' || explicit === 'websocket') return explicit;
  if (command) return 'stdio';
  if (url?.startsWith('ws')) return 'websocket';
  if (url?.includes('/sse')) return 'sse';
  if (url) return 'http';
  return 'unknown';
}

export function sourceId(integration: string, path: string): string {
  return stableId('src', { integration, path });
}

