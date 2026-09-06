import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
};

type RunPayload = {
  files?: Record<string, string>;
  changedFiles?: string[];
  activeFile?: string;
  sessionId?: string;
};

type ExecPayload = {
  sessionId?: string;
  command?: string;
  waitForReady?: boolean;
};

const PROJECT_DIR = '/workspace/hyperdev-project';

const RUNNERS: Record<string, (dir: string, file: string) => string> = {
  py: (dir, file) => `cd ${dir} && python3 ${file}`,
  js: (dir, file) => `cd ${dir} && node ${file}`,
  mjs: (dir, file) => `cd ${dir} && node ${file}`,
  java: (dir, file) => {
    const className = file.replace(/\.java$/i, '');
    return `cd ${dir} && javac ${file} && java ${className}`;
  },
  c: (dir, file) => `cd ${dir} && gcc ${file} -O2 -o /tmp/hyperdev-app && /tmp/hyperdev-app`,
  cpp: (dir, file) => `cd ${dir} && g++ ${file} -O2 -std=c++17 -o /tmp/hyperdev-app && /tmp/hyperdev-app`,
  cc: (dir, file) => `cd ${dir} && g++ ${file} -O2 -std=c++17 -o /tmp/hyperdev-app && /tmp/hyperdev-app`,
  go: (dir, file) => `cd ${dir} && go run ${file}`,
  rs: (dir, file) => `cd ${dir} && rustc ${file} -O -o /tmp/hyperdev-app && /tmp/hyperdev-app`,
};

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function safePath(name: string) {
  return name
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9_.-]/g, '_'))
    .join('/');
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ext(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function sandboxFor(env: Env, sessionId?: string) {
  const session = (sessionId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
  return getSandbox(env.Sandbox, `hyperdev-${session}`, {
    keepAlive: false,
    sleepAfter: '30m',
    normalizeId: true,
  });
}

function isContainerUnavailable(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes('no container instance that can be provided') ||
    message.includes('containerunavailable') ||
    message.includes('container unavailable') ||
    message.includes('timed out waiting for container instance') ||
    message.includes('container is not running');
}

async function withContainerRetry<T>(operation: () => Promise<T>, retries = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isContainerUnavailable(error) || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function writeFileWithRetry(sandbox: Sandbox, path: string, content: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withContainerRetry(() => sandbox.writeFile(path, content), 3);
      return;
    } catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      const retryable = message.includes('interrupted') || message.includes('updating the sandbox runtime');
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function execWithRetry(sandbox: Sandbox, command: string, timeout: number) {
  return withContainerRetry(() => sandbox.exec(command, { timeout }), 4);
}

async function ensureProject(sandbox: Sandbox) {
  await execWithRetry(sandbox, `mkdir -p ${PROJECT_DIR}`, 30000);
  return PROJECT_DIR;
}

async function warmSandbox(sandbox: Sandbox) {
  const startedAt = Date.now();
  const result = await execWithRetry(sandbox, `mkdir -p ${PROJECT_DIR} && cd ${PROJECT_DIR} && printf ready`, 90000);
  if (!result.success) throw new Error(result.stderr || 'Sandbox warmup failed');
  return Date.now() - startedAt;
}

async function syncProject(sandbox: Sandbox, files: Record<string, string>, changedFiles?: string[]) {
  const marker = `${PROJECT_DIR}/.hyperdev_synced`;
  const probe = await execWithRetry(sandbox, `test -f ${marker}`, 15000);
  const firstSync = !probe.success;
  const requested = firstSync ? Object.keys(files) : (changedFiles || Object.keys(files));
  const names = [...new Set(requested)].filter((name) => files[name] !== undefined);

  if (!names.length) return { firstSync, synced: 0 };

  const dirs = new Set<string>([PROJECT_DIR]);
  const prepared = names.map((name) => {
    const safe = safePath(name);
    const fullPath = `${PROJECT_DIR}/${safe}`;
    const slash = fullPath.lastIndexOf('/');
    if (slash > 0) dirs.add(fullPath.slice(0, slash));
    return { fullPath, content: String(files[name]) };
  });

  await execWithRetry(sandbox, `mkdir -p ${[...dirs].map(shellQuote).join(' ')}`, 30000);

  const concurrency = 6;
  for (let i = 0; i < prepared.length; i += concurrency) {
    await Promise.all(
      prepared.slice(i, i + concurrency).map(({ fullPath, content }) =>
        writeFileWithRetry(sandbox, fullPath, content)
      )
    );
  }

  if (firstSync) await execWithRetry(sandbox, `touch ${marker}`, 15000);
  return { firstSync, synced: prepared.length };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox/connect') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
        const body = (await request.json().catch(() => ({}))) as ExecPayload;
        const sandbox = sandboxFor(env, body.sessionId);
        const warmupMs = await warmSandbox(sandbox);
        return json({ connected: true, ready: true, warmupMs, projectDir: PROJECT_DIR });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }

    if (url.pathname === '/api/sandbox/exec') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
        const body = (await request.json()) as ExecPayload;
        const command = String(body.command || '').trim();
        if (!command) return json({ error: '명령어가 없습니다.' }, { status: 400 });
        const sandbox = sandboxFor(env, body.sessionId);
        const result = await execWithRetry(sandbox, `mkdir -p ${PROJECT_DIR} && cd ${PROJECT_DIR} && ${command}`, 180000);
        return json({ stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode, success: result.success });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }

    if (url.pathname === '/api/run') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
        const startedAt = Date.now();
        const body = (await request.json()) as RunPayload;
        const files = body.files || {};
        const requestedActiveFile = body.activeFile || '';
        if (!requestedActiveFile || files[requestedActiveFile] === undefined) {
          return json({ error: '실행할 파일이 없습니다.' }, { status: 400 });
        }

        const activeFile = safePath(requestedActiveFile);
        const extension = ext(activeFile);
        const runner = RUNNERS[extension];
        if (!runner) return json({ error: `지원하지 않는 실행 형식입니다: .${extension || '(없음)'}` }, { status: 400 });

        const sandbox = sandboxFor(env, body.sessionId);
        const projectDir = await ensureProject(sandbox);
        const syncStartedAt = Date.now();
        const sync = await syncProject(sandbox, files, body.changedFiles);
        const syncMs = Date.now() - syncStartedAt;

        const execStartedAt = Date.now();
        const result = await execWithRetry(sandbox, runner(projectDir, activeFile), 120000);
        const execMs = Date.now() - execStartedAt;

        return json({
          engine: 'cloudflare-sandbox',
          language: extension,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: result.exitCode,
          success: result.success,
          syncedFiles: sync.synced,
          firstSync: sync.firstSync,
          timing: { syncMs, execMs, totalMs: Date.now() - startedAt },
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
