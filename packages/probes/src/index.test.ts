import { describe, expect, it } from 'vitest';
import { createMcpProbe, createSecretProbe } from './index';

describe('probes', () => {
  it('extracts MCP servers without env values', () => {
    const probe = createMcpProbe();
    const servers = probe.extractMcpServers({
      mcp_servers: {
        node: { command: 'node', args: ['server.js'], env: { API_KEY: 'secret' } },
        remote: { url: 'https://example.com/sse' }
      }
    });
    expect(servers).toHaveLength(2);
    expect(servers[0]?.envKeys).toEqual(['API_KEY']);
    expect(JSON.stringify(servers)).not.toContain('secret');
  });

  it('detects secret strings', () => {
    expect(createSecretProbe().containsSecret('Bearer abcdefghijklmnopqrstuvwxyz')).toHaveLength(1);
  });
});

