import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentSourceType =
  | 'ai-coding'
  | 'agent-cli'
  | 'mcp-client'
  | 'mcp-server'
  | 'automation'
  | 'custom';

export type AgentEventType =
  | 'session.start'
  | 'session.end'
  | 'message.input'
  | 'message.output'
  | 'tool.call'
  | 'tool.result'
  | 'permission.request'
  | 'network.request'
  | 'network.response'
  | 'error'
  | 'custom';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type Scope = 'workspace' | 'user' | 'global';
export type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stalled' | 'unknown';
export type CapabilityStatus =
  | 'discovered'
  | 'configured'
  | 'reported-by-agent'
  | 'observed-used'
  | 'missing'
  | 'error';

export interface AgentEvent {
  id: string;
  source: string;
  sourceType: AgentSourceType;
  eventType: AgentEventType;
  timestamp: string;
  projectId?: string;
  workspace?: string;
  sessionId?: string;
  correlationId?: string;
  raw: unknown;
  normalized: Record<string, unknown>;
  riskLevel?: RiskLevel;
  tags?: string[];
}

export interface SessionRecord {
  id: string;
  source: string;
  workspace?: string;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface TaskRecord {
  id: string;
  sessionId?: string;
  source: string;
  workspace?: string;
  status: TaskStatus;
  title?: string;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  lastEventId?: string;
}

export interface InventorySource {
  id: string;
  integration: string;
  scope: Scope;
  kind: 'skill-dir' | 'mcp-config' | 'plugin-dir' | 'tool-config';
  path: string;
  exists: boolean;
  lastModifiedAt?: string;
}

export interface SkillInventoryItem {
  id: string;
  name: string;
  description?: string;
  integration?: string;
  scope: Scope;
  directory: string;
  entryFile?: string;
  enabled: boolean;
  sourcePath: string;
  lastModifiedAt?: string;
  hash?: string;
  status?: CapabilityStatus;
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';

export interface McpServerInventoryItem {
  id: string;
  name: string;
  integration?: string;
  scope: Scope;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  enabled: boolean;
  sourcePath: string;
  lastModifiedAt?: string;
  riskLevel?: RiskLevel;
  status?: CapabilityStatus;
}

export interface PluginInventoryItem {
  id: string;
  name: string;
  integration?: string;
  scope: Scope;
  directory: string;
  manifestPath?: string;
  enabled: boolean;
  sourcePath: string;
  lastModifiedAt?: string;
  status?: CapabilityStatus;
}

export interface ProbeWarning {
  code: string;
  message: string;
  path?: string;
}

export interface ProbeError {
  code: string;
  message: string;
  path?: string;
}

export interface ProbeResult<T> {
  ok: boolean;
  value?: T;
  confidence?: 'low' | 'medium' | 'high';
  reasons?: string[];
  warnings?: ProbeWarning[];
  errors?: ProbeError[];
}

export interface PlanRisk {
  level: RiskLevel;
  message: string;
}

export type ConfigPatchFormat = 'json' | 'jsonc' | 'toml' | 'text';
export type ConfigPatchWriteMode = 'replace' | 'merge' | 'structured-patch';
export type ProxyStreamingMode = 'passthrough' | 'capture-summary' | 'capture-chunks';

export interface AgentConfigRouteState {
  integration: string;
  routed: boolean;
  configPath?: string;
  currentBaseUrl?: string;
  originalUpstream?: string;
  confidence: 'low' | 'medium' | 'high';
  warnings: string[];
  summary?: Record<string, unknown>;
}

export interface InstallVerification {
  ok: boolean;
  checkedFiles: string[];
  expectedProxyBaseUrl?: string;
  warnings: string[];
}

export interface ProxyRouteProfile {
  provider: ProxyRequestRecord['provider'] | 'opencode';
  localRoute: string;
  upstreamEnv: string;
  defaultUpstream: string;
  streamingMode: ProxyStreamingMode;
  sensitiveHeaders: string[];
  pathMode: 'preserve';
}

export interface ProxyRouteMapping {
  integration: string;
  provider: ProxyRouteProfile['provider'];
  localRoute: string;
  proxyBaseUrl: string;
  upstreamBaseUrl: string;
  sourceConfigPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FilePatchAction {
  type: 'file.patch';
  filePath: string;
  description: string;
  before?: unknown;
  after: unknown;
  backupRequired: true;
  scope?: Scope;
  format?: ConfigPatchFormat;
  writeMode?: ConfigPatchWriteMode;
  preserveFormatting?: boolean;
}

export interface EnvUpdateAction {
  type: 'env.update';
  scope: Scope | 'process';
  key: string;
  oldValue?: string;
  newValue: string;
  backupRequired: boolean;
}

export interface CommandSuggestionAction {
  type: 'command.suggestion';
  command: string;
  reason: string;
}

export type InstallAction = FilePatchAction | EnvUpdateAction | CommandSuggestionAction;

export interface RollbackPlan {
  backupId: string;
  files: Array<{ filePath: string; backupPath: string }>;
}

export interface InstallPlan {
  id: string;
  integration: string;
  createdAt: string;
  actions: InstallAction[];
  risks: PlanRisk[];
  rollback: RollbackPlan;
  scope: Scope;
  summary?: string;
  preflight?: AgentConfigRouteState;
  verification?: InstallVerification;
  proxyRoute?: ProxyRouteProfile;
}

export interface InstallResult {
  ok: boolean;
  planId: string;
  appliedActions: number;
  warnings: string[];
  verification?: InstallVerification;
}

export interface RollbackResult {
  ok: boolean;
  backupId?: string;
  restoredFiles: string[];
  deletedFiles?: string[];
  warnings: string[];
}

export interface ScanResult {
  integration: string;
  detected: boolean;
  sourceType: AgentSourceType;
  configSources: InventorySource[];
  capabilities: {
    hook: boolean;
    proxy: boolean;
    transcript: boolean;
    configInstall: boolean;
    rollback: boolean;
  };
  reasons: string[];
  warnings: string[];
  routeState?: AgentConfigRouteState;
}

export interface ProxyRequestRecord {
  id: string;
  provider: 'openai' | 'anthropic' | 'codex' | 'claude-code';
  method: string;
  path: string;
  upstreamUrl: string;
  statusCode?: number;
  durationMs?: number;
  requestSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

export interface AnalysisResult {
  id: string;
  eventId?: string;
  proxyRequestId?: string;
  analyzer: string;
  riskLevel: RiskLevel;
  findings: Array<{ code: string; message: string; path?: string }>;
  createdAt: string;
}

export interface ChannelSendInput {
  channel: 'webhook' | 'windows';
  title: string;
  message: string;
  event?: AgentEvent;
  config?: Record<string, unknown>;
}

export interface ChannelSendResult {
  success: boolean;
  channel: string;
  messageId?: string;
  error?: string;
}

export interface InventorySnapshot {
  sources: InventorySource[];
  skills: SkillInventoryItem[];
  mcpServers: McpServerInventoryItem[];
  plugins: PluginInventoryItem[];
  scannedAt: string;
}

export function newId(prefix = 'ap'): string {
  return `${prefix}_${randomUUID()}`;
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getDataDir(): string {
  return process.env.AGENT_PULSE_DATA_DIR || join(homedir(), '.agent-pulse');
}

export function getDefaultDatabasePath(): string {
  return join(getDataDir(), 'agent-pulse.db');
}

export function eventTypeToTaskStatus(eventType: AgentEventType): TaskStatus {
  if (eventType === 'permission.request') return 'waiting';
  if (eventType === 'session.end' || eventType === 'message.output' || eventType === 'tool.result') return 'completed';
  if (eventType === 'error') return 'failed';
  return 'running';
}

export function maxRisk(left: RiskLevel = 'none', right: RiskLevel = 'none'): RiskLevel {
  const order: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(left), order.indexOf(right))] ?? 'none';
}

export function summarizeUnknown(value: unknown, maxLength = 2048): Record<string, unknown> {
  const redacted = redactSecrets(value);
  const text = JSON.stringify(redacted);
  if (text.length <= maxLength) return { value: redacted, truncated: false };
  return { value: `${text.slice(0, maxLength)}…`, truncated: true };
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return redactSecretString(value);
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = '<redacted>';
    } else {
      output[key] = redactSecrets(item);
    }
  }
  return output;
}

export function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|token|secret|password|passwd|authorization|cookie|session)/i.test(key);
}

export function redactSecretString(value: string): string {
  return value.replace(
    /(sk-[a-zA-Z0-9_-]{16,}|xox[baprs]-[a-zA-Z0-9-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|Bearer\s+[a-zA-Z0-9._-]{16,})/g,
    '<redacted>'
  );
}

