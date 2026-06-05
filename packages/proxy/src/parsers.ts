import { ProxyApiProtocol } from '@agent-pulse/core';

export interface AgentVersion {
  raw: string;
  major: number;
  minor: number;
  patch?: number;
}

export interface StreamingSummaryCapture {
  append(chunk: Buffer): void;
  summary(): Record<string, unknown>;
}

export interface ResponseParserSelectionInput {
  agent: string;
  apiProtocol: ProxyApiProtocol;
  agentVersion?: string;
  maxTextLength: number;
}

export interface ResponseParserSelection {
  parser: VersionedAgentResponseParser;
  requestedVersion?: AgentVersion;
  matchedBy: 'agent-major-minor' | 'agent-latest' | 'protocol-latest';
  dynamicLoadDeferred: boolean;
}

interface ParserVersion {
  major: number;
  minor: number;
}

type SseSummaryMode = 'anthropic' | 'openai';

export abstract class VersionedAgentResponseParser {
  abstract readonly id: string;
  abstract readonly agent: string;
  abstract readonly apiProtocol: ProxyApiProtocol;
  abstract readonly version: ParserVersion;
  protected abstract readonly sseSummaryMode: SseSummaryMode;

  supportsMajorMinor(version: AgentVersion): boolean {
    return this.version.major === version.major && this.version.minor === version.minor;
  }

  createStreamingSummaryCapture(input: { maxTextLength: number }): StreamingSummaryCapture {
    return createSseSummaryCapture(this.sseSummaryMode, input.maxTextLength);
  }
}

abstract class OpenAiAgentResponseParser extends VersionedAgentResponseParser {
  readonly apiProtocol = 'openai-compatible';
  protected readonly sseSummaryMode = 'openai';
}

abstract class AnthropicAgentResponseParser extends VersionedAgentResponseParser {
  readonly apiProtocol = 'anthropic-compatible';
  protected readonly sseSummaryMode = 'anthropic';
}

class CodexParserV1_0 extends OpenAiAgentResponseParser {
  readonly id = 'codex.1.0';
  readonly agent = 'codex';
  readonly version = { major: 1, minor: 0 };
}

class ClaudeCodeParserV1_0 extends AnthropicAgentResponseParser {
  readonly id = 'claude-code.1.0';
  readonly agent = 'claude-code';
  readonly version = { major: 1, minor: 0 };
}

class OpenCodeParserV1_0 extends OpenAiAgentResponseParser {
  readonly id = 'opencode.1.0';
  readonly agent = 'opencode';
  readonly version = { major: 1, minor: 0 };
}

class GenericOpenAiParserV1_0 extends OpenAiAgentResponseParser {
  readonly id = 'openai-compatible.1.0';
  readonly agent = '*';
  readonly version = { major: 1, minor: 0 };
}

class GenericAnthropicParserV1_0 extends AnthropicAgentResponseParser {
  readonly id = 'anthropic-compatible.1.0';
  readonly agent = '*';
  readonly version = { major: 1, minor: 0 };
}

const builtInParsers: VersionedAgentResponseParser[] = [
  new CodexParserV1_0(),
  new ClaudeCodeParserV1_0(),
  new OpenCodeParserV1_0(),
  new GenericOpenAiParserV1_0(),
  new GenericAnthropicParserV1_0()
];

export function selectResponseParser(input: ResponseParserSelectionInput): ResponseParserSelection {
  const requestedVersion = input.agentVersion ? parseAgentVersion(input.agentVersion) : undefined;
  const agentParsers = builtInParsers.filter((parser) => parser.agent === input.agent);
  if (requestedVersion) {
    const exact = latestParser(agentParsers.filter((parser) => parser.supportsMajorMinor(requestedVersion)));
    if (exact) {
      return { parser: exact, requestedVersion, matchedBy: 'agent-major-minor', dynamicLoadDeferred: false };
    }
  }

  // Unsupported agent versions fall back to the newest built-in parser; dynamic loading can attach here later.
  const latestAgentParser = latestParser(agentParsers);
  if (latestAgentParser) {
    return {
      parser: latestAgentParser,
      requestedVersion,
      matchedBy: 'agent-latest',
      dynamicLoadDeferred: Boolean(requestedVersion)
    };
  }

  const protocolParser = latestParser(builtInParsers.filter((parser) => parser.agent === '*' && parser.apiProtocol === input.apiProtocol));
  if (!protocolParser) throw new Error(`No response parser registered for ${input.apiProtocol}`);
  return { parser: protocolParser, requestedVersion, matchedBy: 'protocol-latest', dynamicLoadDeferred: false };
}

export function detectAgentVersion(headers: Record<string, string>): string | undefined {
  for (const key of ['x-agent-version', 'x-agent-pulse-agent-version', 'x-codex-version', 'x-claude-code-version', 'x-opencode-version']) {
    const value = headers[key];
    if (value && parseAgentVersion(value)) return value;
  }
  const userAgent = headers['user-agent'];
  const match = userAgent?.match(/(?:codex|claude(?:-code)?|opencode)[/\s-]+(\d+\.\d+(?:\.\d+)?)/i);
  return match?.[1];
}

export function parseAgentVersion(value: string): AgentVersion | undefined {
  const match = value.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match?.[1] || !match[2]) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] ? Number(match[3]) : undefined;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || (patch !== undefined && !Number.isInteger(patch))) return undefined;
  return { raw: value, major, minor, ...(patch !== undefined ? { patch } : {}) };
}

function latestParser(parsers: VersionedAgentResponseParser[]): VersionedAgentResponseParser | undefined {
  return parsers.slice().sort((left, right) => {
    if (right.version.major !== left.version.major) return right.version.major - left.version.major;
    return right.version.minor - left.version.minor;
  })[0];
}

function createSseSummaryCapture(mode: SseSummaryMode, maxTextLength: number): StreamingSummaryCapture {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  let parseErrorCount = 0;
  let model: string | undefined;
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const thinking = createBoundedTextAccumulator(maxTextLength);
  const text = createBoundedTextAccumulator(maxTextLength);

  const processFrame = (frame: string) => {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const rawData = dataLines.join('\n').trim();
    if (!rawData || rawData === '[DONE]') return;
    const data = parseSseJson(rawData);
    if (!data || typeof data !== 'object') {
      parseErrorCount += 1;
      return;
    }
    eventCount += 1;
    if (mode === 'anthropic') applyAnthropicSseEvent(data as Record<string, any>);
    else applyOpenAiSseEvent(data as Record<string, any>);
  };

  const applyAnthropicSseEvent = (event: Record<string, any>) => {
    if (event.type === 'message_start' && event.message && typeof event.message === 'object') {
      if (typeof event.message.model === 'string') model = event.message.model;
      if (event.message.usage && typeof event.message.usage === 'object') usage = { ...usage, ...event.message.usage };
      return;
    }
    if (event.type === 'content_block_start' && event.content_block && typeof event.content_block === 'object') {
      if (event.content_block.type === 'thinking' && typeof event.content_block.thinking === 'string') thinking.append(event.content_block.thinking);
      if (event.content_block.type === 'text' && typeof event.content_block.text === 'string') text.append(event.content_block.text);
      return;
    }
    if (event.type === 'content_block_delta' && event.delta && typeof event.delta === 'object') {
      if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') thinking.append(event.delta.thinking);
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') text.append(event.delta.text);
      return;
    }
    if (event.type === 'message_delta') {
      if (event.delta && typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason;
      if (event.usage && typeof event.usage === 'object') usage = { ...usage, ...event.usage };
    }
  };

  const applyOpenAiSseEvent = (event: Record<string, any>) => {
    if (typeof event.model === 'string') model = event.model;
    if (event.usage && typeof event.usage === 'object') usage = { ...usage, ...event.usage };
    if (Array.isArray(event.choices)) {
      for (const choice of event.choices) {
        if (!choice || typeof choice !== 'object') continue;
        const delta = choice.delta;
        if (delta && typeof delta === 'object') {
          if (typeof delta.content === 'string') text.append(delta.content);
          if (typeof delta.reasoning_content === 'string') thinking.append(delta.reasoning_content);
          if (typeof delta.thinking === 'string') thinking.append(delta.thinking);
        }
        if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason;
      }
      return;
    }
    if (event.type === 'response.created' && event.response && typeof event.response === 'object' && typeof event.response.model === 'string') {
      model = event.response.model;
      return;
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text.append(event.delta);
      return;
    }
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      thinking.append(event.delta);
      return;
    }
    if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
      if (event.response.usage && typeof event.response.usage === 'object') usage = { ...usage, ...event.response.usage };
      if (typeof event.response.status === 'string') stopReason = event.response.status;
    }
  };

  return {
    append(chunk: Buffer) {
      const decoded = decoder.decode(chunk, { stream: true });
      if (!decoded) return;
      buffer += decoded.replace(/\r\n/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        processFrame(frame);
        separator = buffer.indexOf('\n\n');
      }
    },
    summary() {
      const tail = decoder.decode();
      if (tail) this.append(Buffer.from(tail));
      if (buffer.trim()) {
        processFrame(buffer);
        buffer = '';
      }
      return {
        model,
        usage,
        thinking: thinking.value(),
        text: text.value(),
        stopReason,
        eventCount,
        parseErrorCount,
        truncated: thinking.truncated() || text.truncated()
      };
    }
  };
}

function createBoundedTextAccumulator(maxLength: number) {
  const chunks: string[] = [];
  let length = 0;
  let wasTruncated = false;
  return {
    append(value: string) {
      if (!value) return;
      if (length >= maxLength) {
        wasTruncated = true;
        return;
      }
      const remaining = maxLength - length;
      chunks.push(value.slice(0, remaining));
      length += Math.min(value.length, remaining);
      if (value.length > remaining) wasTruncated = true;
    },
    value() {
      return chunks.join('');
    },
    truncated() {
      return wasTruncated;
    }
  };
}

function parseSseJson(text: string): unknown {
  const parsed = safeJson(text);
  if (parsed !== undefined) return parsed;
  if (text.includes('\\"')) return safeJson(text.replace(/\\"/g, '"'));
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
