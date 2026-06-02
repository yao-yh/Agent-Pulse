import {
  AgentSourceType,
  InstallPlan,
  InstallVerification,
  InventorySource,
  ProxyRouteProfile,
  ScanResult,
  Scope
} from '@agent-pulse/core';

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
  readConfigState(input: DetectInput & { scope?: Scope; proxyBaseUrl?: string }): Promise<NonNullable<ScanResult['routeState']>>;
  planProxyInstall(input: PlanInstallInput): Promise<InstallPlan>;
  planInstall(input: PlanInstallInput): Promise<InstallPlan>;
  verifyInstall(plan: InstallPlan): Promise<InstallVerification>;
  getProxyRouteProfile(input?: { proxyBaseUrl?: string }): ProxyRouteProfile;
}

