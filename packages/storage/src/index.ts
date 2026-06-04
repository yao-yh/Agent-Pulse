import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import initSqlJs from 'sql.js';
import {
  AgentEvent,
  AnalysisResult,
  getDefaultDatabasePath,
  InventorySnapshot,
  InstallPlan,
  nowIso,
  ProxyRequestRecord,
  ProxyRouteMapping,
  SessionRecord,
  TaskRecord,
  eventTypeToTaskStatus
} from '@agent-pulse/core';

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });

export interface InstallPlanRecord {
  plan: InstallPlan;
  applied: boolean;
  appliedAt?: string;
}

export interface StorageOptions {
  databasePath?: string;
}

export type AgentPulseStorage = SqliteAgentPulseStorage;

class SqlJsCompatDatabase {
  private readonly database: any;

  constructor(private readonly filePath: string) {
    const bytes = existsSync(filePath) ? readFileSync(filePath) : undefined;
    this.database = new SQL.Database(bytes);
  }

  pragma(_value: string): void {
    // sql.js persists by exporting the database file, so SQLite WAL pragmas do not apply.
  }

  exec(sql: string): void {
    this.database.exec(sql);
    this.persist();
  }

  prepare(sql: string): SqlJsCompatStatement {
    return new SqlJsCompatStatement(this, sql, this.database.prepare(sql));
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: Parameters<T>) => {
      const result = fn(...args);
      this.persist();
      return result;
    }) as T;
  }

  getRowsModified(): number {
    return this.database.getRowsModified();
  }

  persist(): void {
    writeFileSync(this.filePath, Buffer.from(this.database.export()));
  }

  close(): void {
    this.persist();
    this.database.close();
  }
}

class SqlJsCompatStatement {
  constructor(
    private readonly db: SqlJsCompatDatabase,
    private readonly sql: string,
    private readonly statement: any
  ) {}

  run(...params: any[]): { changes: number } {
    try {
      this.bind(params);
      this.statement.step();
      const changes = this.db.getRowsModified();
      this.db.persist();
      return { changes };
    } finally {
      this.statement.free();
    }
  }

  all(...params: any[]): any[] {
    try {
      this.bind(params);
      const rows: any[] = [];
      while (this.statement.step()) rows.push(this.statement.getAsObject());
      return rows;
    } finally {
      this.statement.free();
    }
  }

  get(...params: any[]): any | undefined {
    try {
      this.bind(params);
      return this.statement.step() ? this.statement.getAsObject() : undefined;
    } finally {
      this.statement.free();
    }
  }

  private bind(params: any[]): void {
    if (params.length === 0) return;
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
      this.statement.bind(normalizeNamedParams(this.sql, params[0]));
      return;
    }
    this.statement.bind(params);
  }
}

function normalizeNamedParams(sql: string, params: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const match of sql.matchAll(/[@:$][A-Za-z_][A-Za-z0-9_]*/g)) {
    const placeholder = match[0];
    const bare = placeholder.slice(1);
    if (Object.prototype.hasOwnProperty.call(params, placeholder)) normalized[placeholder] = params[placeholder];
    else if (Object.prototype.hasOwnProperty.call(params, bare)) normalized[placeholder] = params[bare];
  }
  return normalized;
}

class SqliteAgentPulseStorage {
  readonly db: SqlJsCompatDatabase;

  constructor(options: StorageOptions = {}) {
    const databasePath = options.databasePath || getDefaultDatabasePath();
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new SqlJsCompatDatabase(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        project_id TEXT,
        workspace TEXT,
        session_id TEXT,
        correlation_id TEXT,
        raw_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        risk_level TEXT DEFAULT 'none',
        tags_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        workspace TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        source TEXT NOT NULL,
        workspace TEXT,
        status TEXT NOT NULL,
        title TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        last_event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS proxy_requests (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        upstream_url TEXT NOT NULL,
        status_code INTEGER,
        duration_ms INTEGER,
        request_summary_json TEXT,
        response_summary_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_results (
        id TEXT PRIMARY KEY,
        event_id TEXT,
        proxy_request_id TEXT,
        analyzer TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        success INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS install_plans (
        id TEXT PRIMARY KEY,
        integration TEXT NOT NULL,
        scope TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        plan_id TEXT,
        file_path TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
      CREATE TABLE IF NOT EXISTS inventory_sources (
        id TEXT PRIMARY KEY,
        integration TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        exists_flag INTEGER NOT NULL,
        last_modified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        item_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        item_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        item_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
  }

  insertEvent(event: AgentEvent): { inserted: boolean; event: AgentEvent } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
        (id, source, source_type, event_type, timestamp, project_id, workspace, session_id, correlation_id, raw_json, normalized_json, risk_level, tags_json)
        VALUES (@id, @source, @sourceType, @eventType, @timestamp, @projectId, @workspace, @sessionId, @correlationId, @rawJson, @normalizedJson, @riskLevel, @tagsJson)`
      )
      .run({
        id: event.id,
        source: event.source,
        sourceType: event.sourceType,
        eventType: event.eventType,
        timestamp: event.timestamp,
        projectId: event.projectId ?? null,
        workspace: event.workspace ?? null,
        sessionId: event.sessionId ?? null,
        correlationId: event.correlationId ?? null,
        rawJson: JSON.stringify(event.raw),
        normalizedJson: JSON.stringify(event.normalized),
        riskLevel: event.riskLevel ?? 'none',
        tagsJson: JSON.stringify(event.tags ?? [])
      });
    if (result.changes > 0) this.upsertTaskFromEvent(event);
    return { inserted: result.changes > 0, event };
  }

  listEvents(limit = 100): AgentEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?')
      .all(limit)
      .map(rowToEvent);
  }

  updateEventRisk(eventId: string, riskLevel: string): void {
    this.db.prepare('UPDATE events SET risk_level = ? WHERE id = ?').run(riskLevel, eventId);
  }

  private upsertTaskFromEvent(event: AgentEvent): void {
    const now = event.timestamp || nowIso();
    const sessionId = event.sessionId || event.correlationId || `${event.source}:default`;
    const status = eventTypeToTaskStatus(event.eventType);
    this.db
      .prepare(
        `INSERT INTO sessions (id, source, workspace, status, started_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, ended_at = excluded.ended_at`
      )
      .run(sessionId, event.source, event.workspace ?? null, status, now, now, isTerminal(status) ? now : null);

    const taskId = event.correlationId || sessionId;
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, source, workspace, status, title, pid, started_at, updated_at, ended_at, last_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, ended_at = excluded.ended_at, last_event_id = excluded.last_event_id`
      )
      .run(
        taskId,
        sessionId,
        event.source,
        event.workspace ?? null,
        status,
        String(event.normalized.title ?? event.eventType),
        toNumber(event.normalized.pid),
        now,
        now,
        isTerminal(status) ? now : null,
        event.id
      );
  }

  listSessions(limit = 100): SessionRecord[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => ({
        id: row.id,
        source: row.source,
        workspace: row.workspace ?? undefined,
        status: row.status,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at ?? undefined
      }));
  }

  listTasks(limit = 100): TaskRecord[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => ({
        id: row.id,
        sessionId: row.session_id ?? undefined,
        source: row.source,
        workspace: row.workspace ?? undefined,
        status: row.status,
        title: row.title ?? undefined,
        pid: row.pid ?? undefined,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at ?? undefined,
        lastEventId: row.last_event_id ?? undefined
      }));
  }

  markStaleTasks(staleAfterMs: number): number {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    return this.db
      .prepare("UPDATE tasks SET status = 'stalled', updated_at = ? WHERE status IN ('running', 'waiting') AND updated_at < ?")
      .run(nowIso(), cutoff).changes;
  }

  upsertInventory(snapshot: InventorySnapshot): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM inventory_sources').run();
      this.db.prepare('DELETE FROM skills').run();
      this.db.prepare('DELETE FROM mcp_servers').run();
      this.db.prepare('DELETE FROM plugins').run();
      const sourceStmt = this.db.prepare(
        `INSERT INTO inventory_sources (id, integration, scope, kind, path, exists_flag, last_modified_at)
         VALUES (@id, @integration, @scope, @kind, @path, @existsFlag, @lastModifiedAt)`
      );
      for (const source of snapshot.sources) {
        sourceStmt.run({ ...source, existsFlag: source.exists ? 1 : 0, lastModifiedAt: source.lastModifiedAt ?? null });
      }
      const insertJson = (table: string, item: { id: string }) =>
        this.db.prepare(`INSERT INTO ${table} (id, item_json) VALUES (?, ?)`).run(item.id, JSON.stringify(item));
      snapshot.skills.forEach((item) => insertJson('skills', item));
      snapshot.mcpServers.forEach((item) => insertJson('mcp_servers', item));
      snapshot.plugins.forEach((item) => insertJson('plugins', item));
      this.setSetting('inventory.lastScan', snapshot.scannedAt);
    });
    tx();
  }

  getInventory(): InventorySnapshot {
    return {
      sources: this.db
        .prepare('SELECT * FROM inventory_sources ORDER BY integration, kind, path')
        .all()
        .map((row: any) => ({
          id: row.id,
          integration: row.integration,
          scope: row.scope,
          kind: row.kind,
          path: row.path,
          exists: row.exists_flag === 1,
          lastModifiedAt: row.last_modified_at ?? undefined
        })),
      skills: this.readJsonTable('skills'),
      mcpServers: this.readJsonTable('mcp_servers'),
      plugins: this.readJsonTable('plugins'),
      scannedAt: String(this.getSetting('inventory.lastScan') || nowIso())
    };
  }

  insertProxyRequest(record: ProxyRequestRecord): void {
    const requestSummary = {
      ...(record.requestSummary || {}),
      ...(record.proxyKey ? { proxyKey: record.proxyKey } : {}),
      ...(record.apiProtocol ? { apiProtocol: record.apiProtocol } : {})
    };
    this.db
      .prepare(
        `INSERT INTO proxy_requests (id, provider, method, path, upstream_url, status_code, duration_ms, request_summary_json, response_summary_json, error, created_at)
         VALUES (@id, @provider, @method, @path, @upstreamUrl, @statusCode, @durationMs, @requestSummaryJson, @responseSummaryJson, @error, @createdAt)`
      )
      .run({
        ...record,
        statusCode: record.statusCode ?? null,
        durationMs: record.durationMs ?? null,
        requestSummaryJson: Object.keys(requestSummary).length ? JSON.stringify(requestSummary) : null,
        responseSummaryJson: record.responseSummary ? JSON.stringify(record.responseSummary) : null,
        error: record.error ?? null
      });
  }

  listProxyRequests(limit = 100): ProxyRequestRecord[] {
    return this.db
      .prepare('SELECT * FROM proxy_requests ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => {
        const requestSummary = parseJson(row.request_summary_json);
        return {
          id: row.id,
          provider: row.provider,
          proxyKey: typeof requestSummary?.proxyKey === 'string' ? requestSummary.proxyKey : undefined,
          apiProtocol: typeof requestSummary?.apiProtocol === 'string' ? requestSummary.apiProtocol : undefined,
          method: row.method,
          path: row.path,
          upstreamUrl: row.upstream_url,
          statusCode: row.status_code ?? undefined,
          durationMs: row.duration_ms ?? undefined,
          requestSummary,
          responseSummary: parseJson(row.response_summary_json),
          error: row.error ?? undefined,
          createdAt: row.created_at
        };
      });
  }

  insertAnalysis(result: AnalysisResult): void {
    this.db
      .prepare(
        `INSERT INTO analysis_results (id, event_id, proxy_request_id, analyzer, risk_level, findings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.eventId ?? null,
        result.proxyRequestId ?? null,
        result.analyzer,
        result.riskLevel,
        JSON.stringify(result.findings),
        result.createdAt
      );
  }

  insertNotification(input: { id: string; channel: string; success: boolean; title: string; message: string; error?: string }): void {
    this.db
      .prepare('INSERT INTO notifications (id, channel, success, title, message, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.channel, input.success ? 1 : 0, input.title, input.message, input.error ?? null, nowIso());
  }

  saveInstallPlan(plan: InstallPlan, applied = false): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO install_plans (id, integration, scope, plan_json, applied, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT applied_at FROM install_plans WHERE id = ?), NULL))`
      )
      .run(plan.id, plan.integration, plan.scope, JSON.stringify(plan), applied ? 1 : 0, plan.createdAt, plan.id);
  }

  listInstallPlans(limit = 100): InstallPlan[] {
    return this.db
      .prepare('SELECT plan_json FROM install_plans ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => JSON.parse(row.plan_json));
  }

  listInstallPlanRecords(limit = 100): InstallPlanRecord[] {
    return this.db
      .prepare('SELECT plan_json, applied, applied_at FROM install_plans ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row: any) => ({
        plan: JSON.parse(row.plan_json),
        applied: row.applied === 1,
        appliedAt: row.applied_at ?? undefined
      }));
  }

  markPlanApplied(planId: string): void {
    this.db.prepare('UPDATE install_plans SET applied = 1, applied_at = ? WHERE id = ?').run(nowIso(), planId);
  }

  insertBackup(input: { id: string; planId: string; filePath: string; backupPath: string }): void {
    this.db
      .prepare('INSERT INTO backups (id, plan_id, file_path, backup_path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.planId, input.filePath, input.backupPath, nowIso());
  }

  getLatestBackups(): Array<{ id: string; planId: string; filePath: string; backupPath: string }> {
    const latest = this.db.prepare('SELECT plan_id FROM backups ORDER BY created_at DESC LIMIT 1').get() as { plan_id?: string } | undefined;
    if (!latest?.plan_id) return [];
    return this.db
      .prepare('SELECT * FROM backups WHERE plan_id = ? ORDER BY created_at DESC')
      .all(latest.plan_id)
      .map((row: any) => ({ id: row.id, planId: row.plan_id, filePath: row.file_path, backupPath: row.backup_path }));
  }

  getLatestBackupsForIntegration(integration: string): Array<{ id: string; planId: string; filePath: string; backupPath: string }> {
    const latest = this.db
      .prepare(
        `SELECT b.plan_id
         FROM backups b
         JOIN install_plans p ON p.id = b.plan_id
         WHERE p.integration = ? AND p.applied = 1
         ORDER BY b.created_at DESC
         LIMIT 1`
      )
      .get(integration) as { plan_id?: string } | undefined;
    if (!latest?.plan_id) return [];
    return this.db
      .prepare('SELECT * FROM backups WHERE plan_id = ? ORDER BY created_at DESC')
      .all(latest.plan_id)
      .map((row: any) => ({ id: row.id, planId: row.plan_id, filePath: row.file_path, backupPath: row.backup_path }));
  }

  markBackupRestored(backupId: string): void {
    this.db.prepare('UPDATE backups SET restored_at = ? WHERE id = ?').run(nowIso(), backupId);
  }

  listProxyRouteMappings(): ProxyRouteMapping[] {
    const value = this.getSetting('proxy.routeMappings');
    return Array.isArray(value) ? (value.map(normalizeProxyRouteMapping).filter(Boolean) as ProxyRouteMapping[]) : [];
  }

  getProxyRouteMapping(integration: string): ProxyRouteMapping | undefined {
    return this.listProxyRouteMappings().find((mapping) => mapping.integration === integration);
  }

  upsertProxyRouteMapping(input: Omit<ProxyRouteMapping, 'createdAt' | 'updatedAt'>): ProxyRouteMapping {
    const mappings = this.listProxyRouteMappings();
    const now = nowIso();
    const existing = mappings.find((mapping) => mapping.integration === input.integration);
    const next: ProxyRouteMapping = {
      ...input,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.setSetting('proxy.routeMappings', [next, ...mappings.filter((mapping) => mapping.integration !== input.integration)]);
    return next;
  }

  deleteProxyRouteMapping(integration: string): void {
    this.setSetting('proxy.routeMappings', this.listProxyRouteMappings().filter((mapping) => mapping.integration !== integration));
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json?: string } | undefined;
    return parseJson(row?.value_json);
  }

  private readJsonTable<T>(table: string): T[] {
    return this.db
      .prepare(`SELECT item_json FROM ${table} ORDER BY id`)
      .all()
      .map((row: any) => JSON.parse(row.item_json));
  }
}

export function createStorage(options?: StorageOptions): AgentPulseStorage {
  return new SqliteAgentPulseStorage(options);
}

function rowToEvent(row: any): AgentEvent {
  return {
    id: row.id,
    source: row.source,
    sourceType: row.source_type,
    eventType: row.event_type,
    timestamp: row.timestamp,
    projectId: row.project_id ?? undefined,
    workspace: row.workspace ?? undefined,
    sessionId: row.session_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    raw: parseJson(row.raw_json),
    normalized: parseJson(row.normalized_json) ?? {},
    riskLevel: row.risk_level,
    tags: parseJson(row.tags_json) ?? []
  };
}

function parseJson(value: string | null | undefined): any {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeProxyRouteMapping(value: unknown): ProxyRouteMapping | null {
  if (!value || typeof value !== 'object') return null;
  const mapping = value as Partial<ProxyRouteMapping>;
  if (!mapping.integration || !mapping.provider || !mapping.localRoute || !mapping.proxyBaseUrl || !mapping.upstreamBaseUrl) return null;
  return {
    ...mapping,
    integration: mapping.integration,
    provider: mapping.provider,
    proxyKey: mapping.proxyKey || mapping.integration,
    apiProtocol: mapping.apiProtocol || inferApiProtocol(String(mapping.provider || mapping.integration)),
    localRoute: mapping.localRoute,
    proxyBaseUrl: mapping.proxyBaseUrl,
    upstreamBaseUrl: mapping.upstreamBaseUrl,
    createdAt: mapping.createdAt || nowIso(),
    updatedAt: mapping.updatedAt || mapping.createdAt || nowIso()
  };
}

function inferApiProtocol(provider: string): ProxyRouteMapping['apiProtocol'] {
  return provider === 'anthropic' || provider === 'claude-code' ? 'anthropic-compatible' : 'openai-compatible';
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'unknown';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

