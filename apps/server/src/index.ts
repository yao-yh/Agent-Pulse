import { buildApp } from './app.js';

const host = process.env.AGENT_PULSE_HOST || '127.0.0.1';
const port = Number(process.env.AGENT_PULSE_PORT || 8080);

const app = await buildApp();
await app.listen({ host, port });
console.log(`AgentPulse listening at http://${host}:${port}`);

