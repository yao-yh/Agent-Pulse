import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InventorySource, Scope, redactSecrets, stableId } from '@agent-pulse/core';
import { createFileProbe, sourceId } from '@agent-pulse/probes';

const fileProbe = createFileProbe();

export async function buildSources(
  integration: string,
  specs: Array<[Scope, InventorySource['kind'], string]>
): Promise<InventorySource[]> {
  return Promise.all(
    specs.map(async ([scope, kind, path]) => {
      const info = await fileProbe.stat(path);
      return {
        id: sourceId(integration, path),
        integration,
        scope,
        kind,
        path,
        exists: Boolean(info),
        lastModifiedAt: info?.lastModifiedAt
      };
    })
  );
}

export async function readJsonLikeConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readTomlConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8');
    return parseSimpleToml(text);
  } catch {
    return null;
  }
}

export function mergeJsonPatch(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  return deepMerge(base, patch);
}

export function summarizeConfig(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value);
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) return { value: redacted };
  return redacted as Record<string, unknown>;
}

export function getPathValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setPathValue(root: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const output = cloneObject(root) as Record<string, unknown>;
  let current: Record<string, unknown> | unknown[] = output;
  path.forEach((part, index) => {
    if (index === path.length - 1) {
      if (Array.isArray(current)) current[Number(part)] = value;
      else current[part] = value;
      return;
    }
    const next = Array.isArray(current) ? current[Number(part)] : current[part];
    const replacement = next && typeof next === 'object' ? cloneObject(next as Record<string, unknown>) : /^\d+$/.test(path[index + 1] || '') ? [] : {};
    if (Array.isArray(current)) current[Number(part)] = replacement;
    else current[part] = replacement;
    current = replacement as Record<string, unknown> | unknown[];
  });
  return output;
}

export function toToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTomlObject(value, [], lines);
  return `${lines.join('\n')}\n`;
}

export function targetBackupId(planId: string, filePath: string): string {
  return stableId('backup', { planId, filePath });
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      base[key] = deepMerge({ ...current }, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function parseSimpleToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[(.+)]$/)?.[1];
    if (section) {
      current = root;
      for (const part of section.split('.').map((item) => item.replace(/^["']|["']$/g, ''))) {
        current[part] = current[part] && typeof current[part] === 'object' ? current[part] : {};
        current = current[part] as Record<string, unknown>;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    current[line.slice(0, eq).trim()] = parseScalar(line.slice(eq + 1).trim());
  }
  return root;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item.trim()));
  }
  return trimmed;
}

function writeTomlObject(value: Record<string, unknown>, prefix: string[], lines: string[]): void {
  const scalars: Array<[string, unknown]> = [];
  const nested: Array<[string, Record<string, unknown>]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (isPlainObject(item)) nested.push([key, item]);
    else scalars.push([key, item]);
  }
  if (prefix.length) lines.push(`[${prefix.join('.')}]`);
  for (const [key, item] of scalars) lines.push(`${key} = ${formatTomlScalar(item)}`);
  for (const [key, item] of nested) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    writeTomlObject(item, [...prefix, key], lines);
  }
}

function formatTomlScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlScalar).join(', ')}]`;
  if (value == null) return '""';
  return JSON.stringify(String(value));
}

export function directoryName(path: string): string {
  return dirname(path);
}
