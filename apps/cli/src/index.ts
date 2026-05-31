#!/usr/bin/env node
import { Command } from 'commander';
import { buildApp } from '@agent-pulse/server/app';
import { scanInventory } from '@agent-pulse/inventory';
import { applyInstall, planInstall, rollbackLatest, scan } from '@agent-pulse/installer';
import { createStorage } from '@agent-pulse/storage';

const program = new Command();

program
  .name('agent-pulse')
  .description('Local event center for AI agent tools')
  .version('0.1.0');

program.command('scan').description('Scan AI agent integrations').action(async () => {
  const results = await scan(process.cwd());
  printJson(results);
});

program
  .command('inventory')
  .description('Scan local skills, MCP servers, plugins and config sources')
  .option('--skills', 'print only skills')
  .option('--mcp', 'print only MCP servers')
  .option('--diff', 'print diff findings')
  .action(async (options) => {
    const storage = createStorage();
    const snapshot = await scanInventory({ workspaceDir: process.cwd(), storage });
    storage.close();
    if (options.skills) return printJson(snapshot.skills);
    if (options.mcp) return printJson(snapshot.mcpServers);
    if (options.diff) {
      const { diffInventory } = await import('@agent-pulse/inventory');
      return printJson(diffInventory(snapshot));
    }
    printJson(snapshot);
  });

program
  .command('plan')
  .description('Generate install plans without changing files')
  .option('--scope <scope>', 'workspace, user, or global', 'workspace')
  .option('--proxy-base-url <url>', 'AgentPulse local base URL', 'http://127.0.0.1:8080')
  .action(async (options) => {
    const storage = createStorage();
    const plans = await planInstall({ workspaceDir: process.cwd(), scope: options.scope, proxyBaseUrl: options.proxyBaseUrl, storage });
    storage.close();
    printJson(plans);
  });

program
  .command('install')
  .description('Apply the latest generated install plan')
  .option('--scope <scope>', 'workspace, user, or global', 'workspace')
  .option('--yes', 'allow non-workspace writes')
  .action(async (options) => {
    const storage = createStorage();
    let plans = storage.listInstallPlans();
    if (plans.length === 0) {
      plans = await planInstall({ workspaceDir: process.cwd(), scope: options.scope, storage });
    }
    const results = plans.map((plan) => applyInstall(plan, { scope: options.scope, yes: options.yes, storage }));
    storage.close();
    printJson(results);
  });

program.command('rollback').description('Rollback the latest applied plan backup').action(() => {
  const storage = createStorage();
  const result = rollbackLatest({ storage });
  storage.close();
  printJson(result);
});

program
  .command('start')
  .description('Start local AgentPulse server')
  .option('--host <host>', 'host', process.env.AGENT_PULSE_HOST || '127.0.0.1')
  .option('--port <port>', 'port', process.env.AGENT_PULSE_PORT || '8080')
  .action(async (options) => {
    const app = await buildApp({ workspaceDir: process.cwd() });
    await app.listen({ host: options.host, port: Number(options.port) });
    console.log(`AgentPulse listening at http://${options.host}:${options.port}`);
  });

program.command('doctor').description('Check local AgentPulse health').action(async () => {
  const storage = createStorage();
  const integrations = await scan(process.cwd());
  const inventory = storage.getInventory();
  const tasks = storage.listTasks(5);
  storage.close();
  printJson({
    ok: true,
    node: process.version,
    platform: process.platform,
    integrations,
    inventory: {
      sources: inventory.sources.length,
      skills: inventory.skills.length,
      mcpServers: inventory.mcpServers.length,
      plugins: inventory.plugins.length
    },
    recentTasks: tasks
  });
});

program.parseAsync(process.argv);

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
