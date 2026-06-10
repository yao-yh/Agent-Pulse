import type { ProxyPromptPart, ProxyRouteMapping } from '@agent-pulse/core';

export interface ProxyRequestMetadata {
  sessionId?: string;
  promptParts?: ProxyPromptPart[];
}

export function extractProxyRequestMetadata(input: { mapping: ProxyRouteMapping; body: unknown }): ProxyRequestMetadata {
  if (input.mapping.integration !== 'claude-code') return {};
  return extractClaudeCodeRequestMetadata(input.body);
}

function extractClaudeCodeRequestMetadata(body: unknown): ProxyRequestMetadata {
  const value = normalizeBodyObject(body);
  if (!isRecord(value)) return {};
  return {
    ...extractClaudeCodeSessionMetadata(value),
    promptParts: extractClaudeCodePromptParts(value)
  };
}

function extractClaudeCodeSessionMetadata(value: Record<string, unknown>): ProxyRequestMetadata {
  const metadata = value.metadata;
  if (!isRecord(metadata)) return {};
  const userId = normalizeJsonishObject(metadata.user_id);
  if (!isRecord(userId)) return {};
  const sessionId = userId.session_id;
  return typeof sessionId === 'string' && sessionId.trim() ? { sessionId: sessionId.trim() } : {};
}

function extractClaudeCodePromptParts(body: Record<string, unknown>): ProxyPromptPart[] {
  const parts: ProxyPromptPart[] = [];
  collectSystemPromptParts(parts, body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, messageIndex) => collectMessagePromptParts(parts, message, messageIndex));
  return parts;
}

function collectSystemPromptParts(parts: ProxyPromptPart[], system: unknown): void {
  for (const text of textValuesFromContent(system)) {
    parts.push({ kind: 'system', role: 'system', text });
    for (const skill of extractSkillNames(text)) {
      parts.push({ kind: 'skill', role: 'system', name: skill, text: skill });
    }
  }
}

function collectMessagePromptParts(parts: ProxyPromptPart[], message: unknown, messageIndex: number): void {
  if (!isRecord(message)) return;
  const role = typeof message.role === 'string' ? message.role : undefined;
  const content = message.content;
  if (typeof content === 'string') {
    parts.push({ kind: role === 'assistant' ? 'assistant' : 'user', role, index: messageIndex, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  content.forEach((block, blockIndex) => collectContentBlock(parts, block, role, messageIndex, blockIndex));
}

function collectContentBlock(parts: ProxyPromptPart[], block: unknown, role: string | undefined, messageIndex: number, blockIndex: number): void {
  if (!isRecord(block)) return;
  const type = typeof block.type === 'string' ? block.type : undefined;
  if (type === 'text' || type === 'thinking') {
    const text = typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : undefined;
    if (text) parts.push({ kind: role === 'assistant' ? 'assistant' : 'user', role, index: messageIndex, text });
    return;
  }
  if (type === 'tool_use') {
    const name = asString(block.name);
    parts.push({
      kind: isMcpToolName(name) ? 'mcp_call' : 'tool_call',
      role,
      index: messageIndex,
      id: asString(block.id),
      name,
      input: block.input,
      metadata: { blockIndex }
    });
    return;
  }
  if (type === 'tool_result') {
    const text = textValuesFromContent(block.content).join('\n');
    const id = asString(block.tool_use_id);
    const isMcp = isMcpToolName(asString(block.name)) || isMcpToolName(id);
    parts.push({
      kind: isMcp ? 'mcp_result' : 'tool_result',
      role,
      index: messageIndex,
      id,
      name: asString(block.name),
      text,
      metadata: { blockIndex, isError: block.is_error === true }
    });
  }
}

function textValuesFromContent(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) values.push(item);
    else if (isRecord(item)) {
      const text = typeof item.text === 'string' ? item.text : typeof item.thinking === 'string' ? item.thinking : undefined;
      if (text?.trim()) values.push(text);
    }
  }
  return values;
}

function extractSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*[-*]\s+([A-Za-z0-9][A-Za-z0-9:_-]{1,80})\s*:/gm)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(/<skill\b[^>]*\bname=["']([^"']+)["']/gi)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(/\$([A-Za-z0-9][A-Za-z0-9:_-]{1,80})\b/g)) {
    if (match[1]) names.add(match[1]);
  }
  return Array.from(names);
}

function isMcpToolName(value: string | undefined): boolean {
  return Boolean(value && /(^mcp[_-]|^mcp__|__mcp__|^mcp:)/i.test(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeJsonishObject(value: unknown): unknown {
  if (typeof value === 'string') return safeJson(value) ?? value;
  return value;
}

function normalizeBodyObject(body: unknown): unknown {
  if (typeof body === 'string') return safeJson(body);
  if (body instanceof Uint8Array) return safeJson(Buffer.from(body).toString('utf8'));
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
