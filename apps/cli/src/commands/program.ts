/**
 * `shannon program` command — launch scans for all runnable in-scope targets in a program file.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { type StartArgs, start } from './start.js';

interface ProgramArgs {
  file: string;
  repo?: string;
  config?: string;
  workspace?: string;
  output?: string;
  pipelineTesting: boolean;
  dryRun: boolean;
  debug: boolean;
  version: string;
}

interface ProgramTarget {
  name: string;
  url: string;
  repo?: string;
  config?: string;
}

interface ParsedProgram {
  name: string;
  targets: ProgramTarget[];
  skipped: string[];
  notes: string[];
}

type RawObject = Record<string, unknown>;

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeWorkspacePart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return sanitized || 'target';
}

function isExplicitlyOutOfScope(obj: RawObject): boolean {
  const scope = asString(obj.scope)?.toLowerCase();
  const status = asString(obj.status)?.toLowerCase();
  return (
    obj.in_scope === false ||
    obj.out_of_scope === true ||
    obj.eligible_for_submission === false ||
    scope === 'out' ||
    scope === 'out_of_scope' ||
    status === 'out' ||
    status === 'out_of_scope' ||
    status === 'archived' ||
    obj.archived === true
  );
}

function normalizeUrl(candidate: string, assetType?: string): string | null {
  const value = candidate.trim();
  if (!value || value.includes('*')) return null;
  if (/^https?:\/\//i.test(value)) return value;

  const type = assetType?.toLowerCase() ?? '';
  const looksLikeDomain = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value);
  if (looksLikeDomain && ['domain', 'url', 'website', 'web', 'api', ''].includes(type)) {
    return `https://${value}`;
  }

  return null;
}

function readProgramFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`ERROR: Program file not found: ${resolved}`);
    process.exit(1);
  }
  if (!fs.statSync(resolved).isFile()) {
    console.error(`ERROR: Program path is not a file: ${resolved}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  try {
    if (resolved.endsWith('.json')) {
      return JSON.parse(content) as unknown;
    }
    return yaml.load(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: Failed to parse program file: ${message}`);
    process.exit(1);
  }
}

function unwrapPolicyScope(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return value;
  const node = obj.node;
  return node ?? value;
}

function rawTargetList(program: RawObject): unknown[] {
  const scopeObj = asObject(program.scope);
  const candidates = [
    program.targets,
    scopeObj?.inScopeTargets,
    scopeObj?.in_scope_targets,
    scopeObj?.in_scope,
    scopeObj?.targets,
    program.scope,
    program.scopes,
    program.policy_scopes,
    program.target_groups,
    program.targetGroups,
    program.assets,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(unwrapPolicyScope);
    }
  }

  const edges = asObject(program.policy_scopes)?.edges;
  if (Array.isArray(edges)) {
    return edges.map(unwrapPolicyScope);
  }

  return [];
}

function targetFromRaw(value: unknown, index: number, skipped: string[]): ProgramTarget | null {
  if (typeof value === 'string') {
    const url = normalizeUrl(value);
    if (!url) {
      skipped.push(`target ${index + 1}: not a runnable URL/domain (${value})`);
      return null;
    }
    return { name: sanitizeWorkspacePart(value), url };
  }

  const obj = asObject(value);
  if (!obj) {
    skipped.push(`target ${index + 1}: unsupported target entry`);
    return null;
  }

  if (isExplicitlyOutOfScope(obj)) {
    const label = asString(obj.name) ?? asString(obj.asset_identifier) ?? asString(obj.url) ?? `target ${index + 1}`;
    skipped.push(`${label}: out of scope`);
    return null;
  }

  const assetType = asString(obj.asset_type) ?? asString(obj.type);
  const rawUrl =
    asString(obj.url) ??
    asString(obj.web_url) ??
    asString(obj.asset_identifier) ??
    asString(obj.identifier) ??
    asString(obj.domain);
  if (!rawUrl) {
    skipped.push(`target ${index + 1}: missing url, domain, or asset_identifier`);
    return null;
  }

  const url = normalizeUrl(rawUrl, assetType);
  if (!url) {
    skipped.push(`${rawUrl}: not a runnable web URL/domain`);
    return null;
  }

  const name = asString(obj.name) ?? asString(obj.handle) ?? sanitizeWorkspacePart(rawUrl);
  const target: ProgramTarget = { name: sanitizeWorkspacePart(name), url };
  const repo = asString(obj.repo) ?? asString(obj.repository);
  const config = asString(obj.config);
  if (repo) target.repo = repo;
  if (config) target.config = config;
  return target;
}

function parseProgram(filePath: string): ParsedProgram {
  const raw = readProgramFile(filePath);
  const obj = asObject(raw);
  if (!obj) {
    console.error('ERROR: Program file must contain an object');
    process.exit(1);
  }

  const skipped: string[] = [];
  const notes: string[] = [];
  const scopeObj = asObject(obj.scope);
  const inScopeTargets = scopeObj?.inScopeTargets ?? scopeObj?.in_scope_targets;
  if (typeof inScopeTargets === 'string' && inScopeTargets.toLowerCase().includes('requires auth')) {
    notes.push(
      'This file says in-scope targets require an authenticated platform export and are not included in the JSON.',
    );
  }

  const targets = rawTargetList(obj)
    .map((entry, index) => targetFromRaw(entry, index, skipped))
    .filter((target): target is ProgramTarget => target !== null);

  const name = asString(obj.name) ?? asString(obj.handle) ?? path.basename(filePath, path.extname(filePath));
  return {
    name: sanitizeWorkspacePart(name),
    targets,
    skipped,
    notes,
  };
}

function printSummary(parsed: ParsedProgram): void {
  console.log(`Program: ${parsed.name}`);
  console.log(`Runnable in-scope targets: ${parsed.targets.length}`);
  for (const target of parsed.targets) {
    console.log(`  - ${target.name}: ${target.url}`);
  }
  if (parsed.skipped.length > 0) {
    console.log(`Skipped targets: ${parsed.skipped.length}`);
    for (const reason of parsed.skipped.slice(0, 10)) {
      console.log(`  - ${reason}`);
    }
    if (parsed.skipped.length > 10) {
      console.log(`  - ... ${parsed.skipped.length - 10} more`);
    }
  }
  if (parsed.notes.length > 0) {
    console.log('Notes:');
    for (const note of parsed.notes) {
      console.log(`  - ${note}`);
    }
  }
  console.log('');
}

export async function program(args: ProgramArgs): Promise<void> {
  const parsed = parseProgram(args.file);
  printSummary(parsed);

  if (parsed.targets.length === 0) {
    console.error('ERROR: No runnable in-scope web targets found in program file');
    if (parsed.notes.length > 0) {
      console.error('');
      for (const note of parsed.notes) {
        console.error(`  - ${note}`);
      }
      console.error('');
      console.error('Export the authenticated target list from the platform, or add a targets array manually.');
    }
    process.exit(1);
  }

  const workspacePrefix = sanitizeWorkspacePart(args.workspace ?? parsed.name);

  if (args.dryRun) {
    console.log('Dry run complete. No scans started.');
    return;
  }

  for (const [index, target] of parsed.targets.entries()) {
    const workspace = `${workspacePrefix}_${target.name || `target-${index + 1}`}`;
    const output = args.output ? path.join(path.resolve(args.output), workspace) : undefined;
    const startArgs: StartArgs = {
      url: target.url,
      ...((target.repo ?? args.repo) ? { repo: target.repo ?? args.repo } : {}),
      pipelineTesting: args.pipelineTesting,
      debug: args.debug,
      version: args.version,
      workspace,
      ...(target.config || args.config ? { config: target.config ?? args.config } : {}),
      ...(output ? { output } : {}),
    };

    console.log(`[${index + 1}/${parsed.targets.length}] Starting ${target.url}`);
    await start(startArgs);
  }
}
