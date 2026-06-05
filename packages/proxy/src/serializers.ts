import { ProxyApiProtocol } from '@agent-pulse/core';

export interface RequestSerializerSelectionInput {
  apiProtocol: ProxyApiProtocol;
  body: unknown;
}

export interface RequestSerializationInput {
  method: string;
  body: unknown;
}

export interface RequestSerializerSelection {
  serializer: ApiProtocolRequestSerializer;
  model?: string;
  modelProvider?: string;
  matchedBy: 'model' | 'protocol';
}

export abstract class ApiProtocolRequestSerializer {
  abstract readonly id: string;
  abstract readonly apiProtocol: ProxyApiProtocol;
  readonly modelProvider?: string;

  supportsModel(_model: string): boolean {
    return false;
  }

  /**
   * Serialize the request body that will be forwarded upstream.
   * GET and HEAD requests must not carry a fetch body, while raw buffers must stay byte-for-byte compatible.
   */
  serialize(input: RequestSerializationInput): BodyInit | undefined {
    if (input.method === 'GET' || input.method === 'HEAD') return undefined;
    if (input.body === undefined) return undefined;
    if (typeof input.body === 'string') return input.body;
    if (input.body instanceof Uint8Array) return input.body as BodyInit;
    return JSON.stringify(input.body);
  }
}

export class OpenAiCompatibleRequestSerializer extends ApiProtocolRequestSerializer {
  readonly id = 'openai-compatible.default';
  readonly apiProtocol = 'openai-compatible';
}

export class AnthropicCompatibleRequestSerializer extends ApiProtocolRequestSerializer {
  readonly id = 'anthropic-compatible.default';
  readonly apiProtocol = 'anthropic-compatible';
}

export class ChatGptRequestSerializer extends OpenAiCompatibleRequestSerializer {
  readonly id = 'openai-compatible.chatgpt';
  readonly modelProvider = 'chatgpt';

  supportsModel(model: string): boolean {
    return /(^|[-_/])(chatgpt|gpt|o\d)([-_.:/]|$)/i.test(model);
  }
}

export class OpenAiDeepSeekRequestSerializer extends OpenAiCompatibleRequestSerializer {
  readonly id = 'openai-compatible.deepseek';
  readonly modelProvider = 'deepseek';

  supportsModel(model: string): boolean {
    return /(^|[-_/])deepseek([-_.:/]|$)/i.test(model);
  }
}

export class AnthropicDeepSeekRequestSerializer extends AnthropicCompatibleRequestSerializer {
  readonly id = 'anthropic-compatible.deepseek';
  readonly modelProvider = 'deepseek';

  supportsModel(model: string): boolean {
    return /(^|[-_/])deepseek([-_.:/]|$)/i.test(model);
  }
}

export class GlmRequestSerializer extends OpenAiCompatibleRequestSerializer {
  readonly id = 'openai-compatible.glm';
  readonly modelProvider = 'glm';

  supportsModel(model: string): boolean {
    return /(^|[-_/])glm([-_.:/]|$)/i.test(model);
  }
}

const protocolSerializers: Record<ProxyApiProtocol, ApiProtocolRequestSerializer> = {
  'openai-compatible': new OpenAiCompatibleRequestSerializer(),
  'anthropic-compatible': new AnthropicCompatibleRequestSerializer()
};

const modelSerializers: ApiProtocolRequestSerializer[] = [
  new ChatGptRequestSerializer(),
  new OpenAiDeepSeekRequestSerializer(),
  new AnthropicDeepSeekRequestSerializer(),
  new GlmRequestSerializer()
];

export function selectRequestSerializer(input: RequestSerializerSelectionInput): RequestSerializerSelection {
  const model = extractModel(input.body);
  const serializer = model
    ? modelSerializers.find((candidate) => candidate.apiProtocol === input.apiProtocol && candidate.supportsModel(model))
    : undefined;
  if (serializer) {
    return { serializer, model, modelProvider: serializer.modelProvider, matchedBy: 'model' };
  }
  return { serializer: protocolSerializers[input.apiProtocol], model, matchedBy: 'protocol' };
}

function extractModel(body: unknown): string | undefined {
  const value = normalizeBodyObject(body);
  const model = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).model : undefined;
  return typeof model === 'string' && model.trim() ? model : undefined;
}

function normalizeBodyObject(body: unknown): unknown {
  if (typeof body === 'string') return safeJson(body);
  if (body instanceof Uint8Array) return safeJson(Buffer.from(body).toString('utf8'));
  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
