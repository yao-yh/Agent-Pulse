import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir, InstallPlan, InstallResult, newId, nowIso, RollbackResult, Scope } from '@agent-pulse/core';
import { createInstallPlans, scanIntegrations, verifyInstallPlan } from '@agent-pulse/integrations';
import { AgentPulseStorage } from '@agent-pulse/storage';

export async function scan(workspaceDir = process.cwd()) {
  return scanIntegrations(workspaceDir);
}

export async function planInstall(options: {
  workspaceDir?: string;
  scope?: Scope;
  proxyBaseUrl?: string;
  storage?: AgentPulseStorage;
}): Promise<InstallPlan[]> {
  const plans = await createInstallPlans({
    workspaceDir: options.workspaceDir || process.cwd(),
    scope: options.scope || 'workspace',
    proxyBaseUrl: options.proxyBaseUrl || 'http://127.0.0.1:8080'
  });
  plans.forEach((plan) => options.storage?.saveInstallPlan(plan));
  return plans;
}

export async function applyInstall(plan: InstallPlan, options: { scope?: Scope; yes?: boolean; storage?: AgentPulseStorage } = {}): Promise<InstallResult> {
  const scope = options.scope || plan.scope;
  if (scope !== 'workspace' && !options.yes) {
    return { ok: false, planId: plan.id, appliedActions: 0, warnings: ['Refusing to modify non-workspace scope without --yes'] };
  }
  let appliedActions = 0;
  const warnings: string[] = [];
  for (const action of plan.actions) {
    if (action.type !== 'file.patch') continue;
    if ((action.scope || plan.scope) !== 'workspace' && !options.yes) {
      warnings.push(`Skipped non-workspace file ${action.filePath}`);
      continue;
    }
    mkdirSync(dirname(action.filePath), { recursive: true });
    const backupId = newId('backup');
    const backupPath = join(getDataDir(), 'backups', `${backupId}-${encodeURIComponent(action.filePath).replace(/%/g, '_')}`);
    const existedBefore = existsSync(action.filePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    if (existedBefore) {
      copyFileSync(action.filePath, backupPath);
    } else {
      writeFileSync(backupPath, '');
    }
    writeFileSync(`${backupPath}.meta.json`, `${JSON.stringify({ existedBefore, filePath: action.filePath, planId: plan.id, createdAt: nowIso() }, null, 2)}\n`, 'utf8');
    options.storage?.insertBackup({ id: backupId, planId: plan.id, filePath: action.filePath, backupPath });
    writeFileSync(action.filePath, renderPatchContent(action), 'utf8');
    appliedActions += 1;
  }
  const verification = await verifyInstallPlan(plan);
  warnings.push(...verification.warnings);
  if (verification.ok) persistProxyRouteMapping(plan, options.storage);
  options.storage?.markPlanApplied(plan.id);
  return { ok: warnings.length === 0 && verification.ok, planId: plan.id, appliedActions, warnings, verification };
}

export function rollbackLatest(options: { storage: AgentPulseStorage }): RollbackResult {
  return rollbackBackups(options.storage.getLatestBackups(), options.storage);
}

export function rollbackIntegration(integration: string, options: { storage: AgentPulseStorage }): RollbackResult {
  return rollbackBackups(options.storage.getLatestBackupsForIntegration(integration), options.storage);
}

function rollbackBackups(backups: Array<{ id: string; planId?: string; filePath: string; backupPath: string }>, storage: AgentPulseStorage): RollbackResult {
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const warnings: string[] = [];
  for (const backup of backups) {
    try {
      const meta = readBackupMeta(backup.backupPath);
      if (meta?.existedBefore === false) {
        if (existsSync(backup.filePath)) {
          unlinkSync(backup.filePath);
          deletedFiles.push(backup.filePath);
        }
      } else {
        mkdirSync(dirname(backup.filePath), { recursive: true });
        copyFileSync(backup.backupPath, backup.filePath);
        restoredFiles.push(backup.filePath);
      }
      storage.markBackupRestored(backup.id);
    } catch (error) {
      warnings.push(`Failed to restore ${backup.filePath}: ${String(error)}`);
    }
  }
  if (warnings.length === 0 && (restoredFiles.length > 0 || deletedFiles.length > 0)) {
    deleteProxyRouteMappingsForBackups(backups, storage);
  }
  return { ok: warnings.length === 0 && (restoredFiles.length > 0 || deletedFiles.length > 0), backupId: backups[0]?.id, restoredFiles, deletedFiles, warnings };
}

function persistProxyRouteMapping(plan: InstallPlan, storage?: AgentPulseStorage): void {
  if (!storage || !plan.proxyRoute || !plan.verification?.expectedProxyBaseUrl) return;
  const localRoute = plan.proxyRoute.localRoute;
  const current = plan.preflight?.currentBaseUrl;
  const upstreamBaseUrl = plan.preflight?.originalUpstream || (current && !current.includes(localRoute) ? current : undefined) || plan.proxyRoute.defaultUpstream;
  storage.upsertProxyRouteMapping({
    integration: plan.integration,
    provider: plan.proxyRoute.provider,
    localRoute,
    proxyBaseUrl: plan.verification.expectedProxyBaseUrl,
    upstreamBaseUrl,
    sourceConfigPath: plan.preflight?.configPath
  });
}

function deleteProxyRouteMappingsForBackups(backups: Array<{ planId?: string }>, storage: AgentPulseStorage): void {
  const records = storage.listInstallPlanRecords();
  const integrations = new Set<string>();
  for (const backup of backups) {
    const integration = records.find((record) => record.plan.id === backup.planId)?.plan.integration;
    if (integration) integrations.add(integration);
  }
  integrations.forEach((integration) => storage.deleteProxyRouteMapping(integration));
}

function renderPatchContent(action: Extract<InstallPlan['actions'][number], { type: 'file.patch' }>): string {
  if (action.format === 'toml') return toToml(action.after && typeof action.after === 'object' ? (action.after as Record<string, unknown>) : {});
  if (action.format === 'text') return String(action.after ?? '');
  return `${JSON.stringify(action.after, null, 2)}\n`;
}

function readBackupMeta(backupPath: string): { existedBefore: boolean } | null {
  try {
    return JSON.parse(readFileSync(`${backupPath}.meta.json`, 'utf8')) as { existedBefore: boolean };
  } catch {
    return null;
  }
}

function toToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTomlObject(value, [], lines);
  return `${lines.join('\n')}\n`;
}

function writeTomlObject(value: Record<string, unknown>, prefix: string[], lines: string[]): void {
  const scalars: Array<[string, unknown]> = [];
  const nested: Array<[string, Record<string, unknown>]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) nested.push([key, item as Record<string, unknown>]);
    else scalars.push([key, item]);
  }
  if (prefix.length) lines.push(`[${prefix.join('.')}]`);
  scalars.forEach(([key, item]) => lines.push(`${key} = ${formatTomlScalar(item)}`));
  for (const [key, item] of nested) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    writeTomlObject(item, [...prefix, key], lines);
  }
}

function formatTomlScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlScalar).join(', ')}]`;
  if (value == null) return '""';
  return JSON.stringify(String(value));
}

