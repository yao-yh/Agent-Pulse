import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir, InstallPlan, InstallResult, newId, RollbackResult, Scope } from '@agent-pulse/core';
import { createInstallPlans, scanIntegrations } from '@agent-pulse/integrations';
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

export function applyInstall(plan: InstallPlan, options: { scope?: Scope; yes?: boolean; storage?: AgentPulseStorage } = {}): InstallResult {
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
    mkdirSync(dirname(backupPath), { recursive: true });
    if (existsSync(action.filePath)) {
      copyFileSync(action.filePath, backupPath);
    } else {
      writeFileSync(backupPath, '');
    }
    options.storage?.insertBackup({ id: backupId, planId: plan.id, filePath: action.filePath, backupPath });
    writeFileSync(action.filePath, `${JSON.stringify(action.after, null, 2)}\n`, 'utf8');
    appliedActions += 1;
  }
  options.storage?.markPlanApplied(plan.id);
  return { ok: warnings.length === 0, planId: plan.id, appliedActions, warnings };
}

export function rollbackLatest(options: { storage: AgentPulseStorage }): RollbackResult {
  const backups = options.storage.getLatestBackups();
  const restoredFiles: string[] = [];
  const warnings: string[] = [];
  for (const backup of backups) {
    try {
      mkdirSync(dirname(backup.filePath), { recursive: true });
      copyFileSync(backup.backupPath, backup.filePath);
      restoredFiles.push(backup.filePath);
    } catch (error) {
      warnings.push(`Failed to restore ${backup.filePath}: ${String(error)}`);
    }
  }
  return { ok: warnings.length === 0 && restoredFiles.length > 0, backupId: backups[0]?.id, restoredFiles, warnings };
}

