// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import type { AuditSession } from '../audit/index.js';
import { deliverablesDir } from '../paths.js';
import { isRetryableError } from '../services/error-handling.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { ProviderConfig } from '../types/config.js';
import { formatTimestamp } from '../utils/formatting.js';
import { Timer } from '../utils/metrics.js';
import { createAuditLogger } from './audit-logger.js';
import type { ClaudePromptResult } from './claude-executor.js';
import { type ModelTier, resolveCodexModel } from './models.js';
import {
  detectExecutionContext,
  formatAssistantOutput,
  formatCompletionMessage,
  formatErrorOutput,
} from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: CodexUsage;
}

let codexAuthPromise: Promise<void> | null = null;

export function isCodexProvider(providerConfig?: ProviderConfig): boolean {
  return providerConfig?.providerType === 'codex_cli' || process.env.SHANNON_AI_PROVIDER?.toLowerCase() === 'codex';
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number,
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'codex-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack,
      },
      context: {
        sourceDir,
        prompt: `${fullPrompt.slice(0, 200)}...`,
        retryable: isRetryableError(err),
      },
      duration,
    };
    const logPath = path.join(deliverablesDir(sourceDir), 'error.log');
    await writeFile(logPath, `${JSON.stringify(errorLog)}\n`, { flag: 'a' });
  } catch {
    // Best-effort error log writing - don't propagate failures
  }
}

function parseJsonLine(line: string): CodexEvent | null {
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
}

function parseStructuredOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('Codex did not return valid JSON for the requested output schema');
  }
}

function runCodexProcess(
  args: string[],
  fullPrompt: string,
  sourceDir: string,
  env: NodeJS.ProcessEnv,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: sourceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onStdoutLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onStderrLine(line);
      }
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (stdoutBuffer.trim()) onStdoutLine(stdoutBuffer.trim());
      if (stderrBuffer.trim()) onStderrLine(stderrBuffer.trim());

      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderrBuffer.trim() || stdoutBuffer.trim();
      reject(
        new Error(
          detail
            ? `Codex CLI exited with code ${code ?? 'unknown'}: ${detail.slice(0, 1000)}`
            : `Codex CLI exited with code ${code ?? 'unknown'}`,
        ),
      );
    });

    child.stdin.end(fullPrompt);
  });
}

function runCodexLogin(args: string[], secret: string, sourceDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: sourceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Codex login failed with code ${code ?? 'unknown'}: ${stderr.trim()}`));
    });

    child.stdin.end(`${secret}\n`);
  });
}

async function ensureCodexAuth(sourceDir: string, env: NodeJS.ProcessEnv, logger: ActivityLogger): Promise<void> {
  if (!codexAuthPromise) {
    codexAuthPromise = (async () => {
      if (env.OPENAI_API_KEY) {
        await runCodexLogin(['login', '--with-api-key'], env.OPENAI_API_KEY, sourceDir, env);
        logger.info('Prepared Codex CLI authentication from OPENAI_API_KEY');
        return;
      }

      if (env.CODEX_ACCESS_TOKEN) {
        await runCodexLogin(['login', '--with-access-token'], env.CODEX_ACCESS_TOKEN, sourceDir, env);
        logger.info('Prepared Codex CLI authentication from CODEX_ACCESS_TOKEN');
        return;
      }

      logger.info('Using Codex CLI OAuth state from CODEX_HOME or the default Codex home');
    })();
  }

  await codexAuthPromise;
}

export async function runCodexPrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Codex analysis',
  _agentName: string | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium',
  outputFormat?: JsonSchemaOutputFormat,
  _apiKey?: string,
  deliverablesSubdir?: string,
  providerConfig?: ProviderConfig,
): Promise<ClaudePromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false,
  );
  const auditLogger = createAuditLogger(auditSession);
  const logPromises: Promise<void>[] = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shannon-codex-'));
  const outputPath = path.join(tempDir, 'last-message.txt');
  const schemaPath = path.join(tempDir, 'output-schema.json');

  logger.info(`Running Codex CLI: ${description}...`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_MCP_OUTPUT_DIR: deliverablesSubdir
      ? path.join(sourceDir, path.dirname(deliverablesSubdir), '.playwright-cli')
      : path.join(sourceDir, '.shannon', '.playwright-cli'),
    ...(deliverablesSubdir && { SHANNON_DELIVERABLES_SUBDIR: deliverablesSubdir }),
  };

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never',
    '--cd',
    sourceDir,
    '--output-last-message',
    outputPath,
  ];

  const model = resolveCodexModel(modelTier, providerConfig?.modelOverrides);
  if (model) {
    args.push('--model', model);
  }

  if (outputFormat?.schema) {
    await writeFile(schemaPath, JSON.stringify(outputFormat.schema, null, 2), 'utf8');
    args.push('--output-schema', schemaPath);
  }

  let turnCount = 0;
  let tokenUsage: CodexUsage = {};

  progress.start();

  try {
    await ensureCodexAuth(sourceDir, env, logger);

    await runCodexProcess(
      args,
      fullPrompt,
      sourceDir,
      env,
      (line) => {
        const event = parseJsonLine(line);
        if (!event) {
          logger.info(`Codex stdout: ${line}`);
          return;
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          turnCount++;
          progress.stop();
          outputLines(formatAssistantOutput(event.item.text, execContext, turnCount, description));
          progress.start();
          logPromises.push(auditLogger.logLlmResponse(turnCount, event.item.text));
        } else if (event.type === 'turn.completed' && event.usage) {
          tokenUsage = event.usage;
        } else if (event.type === 'item.completed' && event.item?.type) {
          logger.info(`Codex item completed: ${event.item.type}`);
        }
      },
      (line) => logger.info(`Codex stderr: ${line}`),
    );

    await Promise.all(logPromises);

    const result = await readFile(outputPath, 'utf8');
    const trimmedResult = result.trim();
    const structuredOutput = outputFormat ? parseStructuredOutput(trimmedResult) : undefined;
    const duration = timer.stop();

    logger.info('Codex token usage', tokenUsage as Record<string, unknown>);
    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result: trimmedResult || null,
      success: true,
      duration,
      turns: turnCount,
      cost: 0,
      ...(model && { model }),
      partialCost: 0,
      ...(structuredOutput !== undefined && { structuredOutput }),
    };
  } catch (error) {
    const duration = timer.stop();
    const err = error as Error & { code?: string; status?: number };

    await Promise.all(logPromises);
    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: `${fullPrompt.slice(0, 100)}...`,
      success: false,
      duration,
      cost: 0,
      retryable: isRetryableError(err),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
