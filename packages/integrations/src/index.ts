import { resolve } from 'node:path';
import { InstallPlan, InstallVerification, InventorySource, ScanResult } from '@agent-pulse/core';
import { adapters } from './adapters/index.js';
import { IntegrationAdapter, PlanInstallInput } from './types.js';

export { adapters } from './adapters/index.js';
export type { DetectInput, IntegrationAdapter, PlanInstallInput } from './types.js';

export function getAdapterByName(name: string): IntegrationAdapter | undefined {
  return adapters.find((adapter) => adapter.name === name);
}

export async function scanIntegrations(workspaceDir = process.cwd()): Promise<ScanResult[]> {
  return Promise.all(adapters.map((adapter) => adapter.detect({ workspaceDir: resolve(workspaceDir) })));
}

export async function collectIntegrationSources(workspaceDir = process.cwd()): Promise<InventorySource[]> {
  const groups = await Promise.all(adapters.map((adapter) => adapter.getInventorySources({ workspaceDir: resolve(workspaceDir) })));
  return groups.flat();
}

export async function createInstallPlans(input: PlanInstallInput): Promise<InstallPlan[]> {
  return Promise.all(adapters.map((adapter) => adapter.planProxyInstall({ ...input, workspaceDir: resolve(input.workspaceDir) })));
}

export async function verifyInstallPlan(plan: InstallPlan): Promise<InstallVerification> {
  const adapter = getAdapterByName(plan.integration);
  if (!adapter) {
    return { ok: false, checkedFiles: [], expectedProxyBaseUrl: plan.verification?.expectedProxyBaseUrl, warnings: [`Unknown integration: ${plan.integration}`] };
  }
  return adapter.verifyInstall(plan);
}

