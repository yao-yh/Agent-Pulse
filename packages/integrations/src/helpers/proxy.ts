import { ProxyRouteProfile } from '@agent-pulse/core';

const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'api-key', 'anthropic-api-key', 'session'];

export function normalizeProxyBaseUrl(proxyBaseUrl: string, route: string): string {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
}

export function openAiRouteProfile(provider: 'openai' | 'codex' | 'opencode', localRoute: string): ProxyRouteProfile {
  return {
    provider,
    localRoute,
    upstreamEnv: 'AGENT_PULSE_OPENAI_UPSTREAM',
    defaultUpstream: 'https://api.openai.com',
    streamingMode: 'passthrough',
    sensitiveHeaders,
    pathMode: 'preserve'
  };
}

export function anthropicRouteProfile(provider: 'anthropic' | 'claude-code', localRoute: string): ProxyRouteProfile {
  return {
    provider,
    localRoute,
    upstreamEnv: 'AGENT_PULSE_ANTHROPIC_UPSTREAM',
    defaultUpstream: 'https://api.anthropic.com',
    streamingMode: 'passthrough',
    sensitiveHeaders,
    pathMode: 'preserve'
  };
}

