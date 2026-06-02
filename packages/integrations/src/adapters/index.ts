import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { openCodeAdapter } from './opencode.js';

export const adapters = [codexAdapter, claudeCodeAdapter, openCodeAdapter];

export { claudeCodeAdapter, codexAdapter, openCodeAdapter };

