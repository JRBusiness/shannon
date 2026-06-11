/**
 * `shannon start` command — launch a pentest scan.
 *
 * Handles both local mode (local build, ./workspaces/, mounted prompts)
 * and npx mode (Docker Hub pull, ~/.shannon/).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureImage, ensureInfra, randomSuffix, spawnWorker } from '../docker.js';
import { buildEnvFlags, loadEnv, validateCredentials } from '../env.js';
import { getCodexHomePath, getCredentialsPath, getWorkspacesDir, initHome } from '../home.js';
import { isLocal } from '../mode.js';
import { resolveConfig, resolveRepo } from '../paths.js';
import { displaySplash } from '../splash.js';

export interface StartArgs {
  url: string;
  repo?: string;
  config?: string;
  workspace?: string;
  output?: string;
  pipelineTesting: boolean;
  debug: boolean;
  version: string;
}

function sanitizeName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'target';
}

function ensureBlackBoxRepo(
  webUrl: string,
  workspace: string,
  workspacesDir: string,
): { hostPath: string; containerPath: string } {
  const repoName = sanitizeName(workspace);
  const hostPath = path.join(workspacesDir, '_blackbox_repos', repoName);
  fs.mkdirSync(hostPath, { recursive: true });

  const readme = `# Shannon Black-Box Target Context

Target URL: ${webUrl}

No source repository was provided for this scan. Treat this directory as a generated context workspace for black-box testing.

Operational guidance:
- Prefer live web and API reconnaissance against the target URL.
- Do not assume local source code exists.
- Store notes, scripts, screenshots, and deliverables under .shannon/.
- If a prompt asks for source-code review, record that source is unavailable and continue with network-observable behavior.
`;

  const agents = `# Black-Box Shannon Context

Source code is not available for this target. Use browser/API observation, target-provided documentation, and permitted runtime behavior only.
`;

  fs.writeFileSync(path.join(hostPath, 'README.md'), readme, 'utf8');
  fs.writeFileSync(path.join(hostPath, 'AGENTS.md'), agents, 'utf8');
  fs.mkdirSync(path.join(hostPath, '.shannon'), { recursive: true });

  const gitDir = path.join(hostPath, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      execFileSync('git', ['init'], { cwd: hostPath, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'agent@localhost'], { cwd: hostPath, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Pentest Agent'], { cwd: hostPath, stdio: 'ignore' });
      execFileSync('git', ['add', 'README.md', 'AGENTS.md'], { cwd: hostPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initialize black-box target context'], { cwd: hostPath, stdio: 'ignore' });
    } catch {
      fs.mkdirSync(gitDir, { recursive: true });
    }
  }

  return {
    hostPath,
    containerPath: `/repos/${repoName}`,
  };
}

export async function start(args: StartArgs): Promise<void> {
  // 1. Initialize state directories and load env
  initHome();
  loadEnv();

  // 2. Validate credentials
  const creds = validateCredentials();
  if (!creds.valid) {
    console.error(`ERROR: ${creds.error}`);
    process.exit(1);
  }

  // 3. Resolve config path
  const config = args.config ? resolveConfig(args.config) : undefined;

  // 4. Ensure workspaces dir is writable by container user (UID 1001)
  const workspacesDir = getWorkspacesDir();
  fs.mkdirSync(workspacesDir, { recursive: true });
  fs.chmodSync(workspacesDir, 0o777);

  // 5. Generate unique task queue and container name
  const suffix = randomSuffix();
  const taskQueue = `shannon-${suffix}`;
  const containerName = `shannon-worker-${suffix}`;

  // 6. Generate workspace name if not provided
  const workspace =
    args.workspace ?? `${new URL(args.url).hostname.replace(/[^a-zA-Z0-9-]/g, '-')}_shannon-${Date.now()}`;

  // 7. Resolve target repository. When absent, create a generated black-box context repo.
  const repo = args.repo ? resolveRepo(args.repo) : ensureBlackBoxRepo(args.url, workspace, workspacesDir);
  const blackBoxMode = !args.repo;

  // 8. Ensure image (auto-build in dev, pull in npx) and start infra
  ensureImage(args.version);
  await ensureInfra();

  // 9. Create writable overlay directories (mounted over :ro repo paths inside container)
  // Workspace dir must be 0o777 so the container user (UID 1001) can create audit subdirs
  const workspacePath = path.join(workspacesDir, workspace);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.chmodSync(workspacePath, 0o777);
  for (const dir of ['deliverables', 'scratchpad', '.playwright-cli', '.playwright']) {
    const dirPath = path.join(workspacePath, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o777);
  }

  // 10. Pre-create overlay mount points (:ro mounts can't auto-create them)
  const shannonDir = path.join(repo.hostPath, '.shannon');
  for (const dir of ['deliverables', 'scratchpad', '.playwright-cli']) {
    fs.mkdirSync(path.join(shannonDir, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(repo.hostPath, '.playwright'), { recursive: true });

  const credentialsPath = getCredentialsPath();
  const hasCredentials = fs.existsSync(credentialsPath);
  const codexHomePath = getCodexHomePath();
  const useCodexOAuth =
    process.env.SHANNON_AI_PROVIDER?.toLowerCase() === 'codex' &&
    fs.existsSync(path.join(codexHomePath, 'auth.json')) &&
    !process.env.OPENAI_API_KEY &&
    !process.env.CODEX_ACCESS_TOKEN;

  if (hasCredentials) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/app/credentials/google-sa-key.json';
  }

  // 11. Resolve output directory
  const outputDir = args.output ? path.resolve(args.output) : undefined;
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 12. Resolve prompts directory (local mode only)
  const promptsDir = isLocal() ? path.resolve('apps/worker/prompts') : undefined;

  // 13. Display splash screen
  displaySplash(isLocal() ? undefined : args.version);

  // 14. Spawn worker container
  const proc = spawnWorker({
    version: args.version,
    url: args.url,
    repo,
    workspacesDir,
    taskQueue,
    containerName,
    envFlags: buildEnvFlags(),
    ...(config && { config }),
    ...(hasCredentials && { credentials: credentialsPath }),
    ...(useCodexOAuth && { codexHome: codexHomePath }),
    ...(promptsDir && { promptsDir }),
    ...(outputDir && { outputDir }),
    workspace,
    ...(args.pipelineTesting && { pipelineTesting: true }),
    ...(args.debug && { debug: true }),
  });

  // 15. Bail if `docker run -d` itself fails (mount error, image missing, etc.)
  const dockerExitCode = await new Promise<number>((resolve) => {
    proc.once('exit', (code) => resolve(code ?? 1));
    proc.once('error', (err) => {
      console.error(`Failed to start worker: ${err.message}`);
      resolve(1);
    });
  });

  if (dockerExitCode !== 0) {
    process.exit(1);
  }

  // Detect whether this is a fresh workspace or a resume by checking session.json existence
  const sessionJson = path.join(workspacesDir, workspace, 'session.json');
  const isResume = fs.existsSync(sessionJson);
  let initialResumeCount = 0;
  if (isResume) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionJson, 'utf-8'));
      initialResumeCount = session.session?.resumeAttempts?.length ?? 0;
    } catch {
      // Corrupted file — worker will handle validation
    }
  }

  // Poll for workflow to register in session.json
  process.stdout.write('Waiting for workflow to start...');
  let workflowId = '';
  let started = false;
  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (attempts > 60) {
      clearInterval(pollInterval);
      process.stdout.write('\n');
      console.error('Timeout waiting for workflow to start');
      process.exit(1);
    }

    try {
      const session = JSON.parse(fs.readFileSync(sessionJson, 'utf-8'));
      const resumeAttempts: { workflowId: string }[] = session.session?.resumeAttempts ?? [];

      // Fresh: session.json appears with originalWorkflowId. Resume: new resumeAttempts entry.
      const ready = isResume ? resumeAttempts.length > initialResumeCount : !!session.session?.originalWorkflowId;

      if (ready) {
        clearInterval(pollInterval);
        started = true;

        // Latest workflow ID: last resume attempt, or originalWorkflowId for fresh scans
        workflowId = resumeAttempts.at(-1)?.workflowId ?? session.session?.originalWorkflowId ?? '';

        // Clear waiting line and show info
        process.stdout.write('\r\x1b[K');
        printInfo(args, workspace, workflowId, repo.hostPath, workspacesDir, blackBoxMode);
        return;
      }
    } catch {
      // File doesn't exist yet
    }
    process.stdout.write('.');
  }, 2000);

  // Stop the worker container only if it hasn't started yet
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned || started) return;
    cleaned = true;
    clearInterval(pollInterval);
    console.log(`\nStopping worker ${containerName}...`);
    try {
      execFileSync('docker', ['stop', containerName], { stdio: 'pipe' });
    } catch {
      // Container may have already exited
    }
    if (args.debug) {
      printDebugHint(containerName);
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);
}

function printDebugHint(containerName: string): void {
  console.log('');
  console.log(`  Worker container preserved: ${containerName}`);
  console.log(`    Inspect logs: docker logs ${containerName}`);
  console.log(`    Remove:       docker rm ${containerName}`);
  console.log('');
}

function printInfo(
  args: StartArgs,
  workspace: string,
  workflowId: string,
  repoPath: string,
  workspacesDir: string,
  blackBoxMode: boolean,
): void {
  const logsCmd = isLocal() ? `./shannon logs ${workspace}` : `npx @keygraph/shannon logs ${workspace}`;
  const reportsPath = path.join(workspacesDir, workspace);

  console.log(`  Target:     ${args.url}`);
  console.log(`  Repository: ${blackBoxMode ? `${repoPath} (generated black-box context)` : repoPath}`);
  console.log(`  Workspace:  ${workspace}`);
  if (args.config) {
    console.log(`  Config:     ${path.resolve(args.config)}`);
  }
  if (args.pipelineTesting) {
    console.log('  Mode:       Pipeline Testing');
  }
  console.log('');
  console.log('  Monitor:');
  if (workflowId) {
    console.log(`    Web UI:  http://localhost:8233/namespaces/default/workflows/${workflowId}`);
  } else {
    console.log('    Web UI:  http://localhost:8233');
  }
  console.log(`    Logs:    ${logsCmd}`);
  console.log('');
  console.log('  Output:');
  console.log(`    Reports: ${reportsPath}/`);
  console.log('');
}
