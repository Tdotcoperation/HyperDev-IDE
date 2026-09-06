import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
};

type RunPayload = {
  files?: Record<string, string>;
  activeFile?: string;
  sessionId?: string;
};

type ExecPayload = {
  sessionId?: string;
  command?: string;
};

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

function ext(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function sandboxFor(env: Env, sessionId?: string) {
  const session = (sessionId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return getSandbox(env.Sandbox, `hyperdev-${session}`);
}

async function writeFileWithRetry(sandbox: Sandbox, path: string, content: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sandbox.writeFile(path, content);
      return;
    } catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      const retryable = message.includes('interrupted') || message.includes('updating the sandbox runtime');
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function ensureProject(sandbox: Sandbox) {
  const dir = '/workspace/hyperdev-project';
  await sandbox.exec(`mkdir -p ${dir}`, { timeout: 30000 });
  return dir;
}

async function warmSandbox(sandbox: Sandbox) {
  try {
    const projectDir = await ensureProject(sandbox);
    await sandbox.exec(`cd ${projectDir} && printf ready`, { timeout: 30000 });
  } catch (error) {
    console.warn('Sandbox warmup failed:', error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox/connect') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
        const body = (await request.json().catch(() => ({}))) as ExecPayload;
        const sandbox = sandboxFor(env, body.sessionId);

        // 사용자에게는 즉시 연결 완료를 반환하고 실제 컨테이너 워밍업은 백그라운드에서 진행한다.
        ctx.waitUntil(warmSandbox(sandbox));

        return json({
          connected: true,
          warming: true,
          projectDir: '/workspace/hyperdev-project',
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    if (url.pathname === '/api/sandbox/exec') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
        const body = (await request.json()) as ExecPayload;
        const command = String(body.command || '').trim();
        if (!command) return json({ error: '명령어가 없습니다.' }, { status: 400 });
        const sandbox = sandboxFor(env, body.sessionId);
        const projectDir = await ensureProject(sandbox);
        const result = await sandbox.exec(`cd ${projectDir} && ${command}`, { timeout: 180000 });
        return json({ stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode, success: result.success });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    if (url.pathname === '/api/run') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      try {
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

        for (const [name, content] of Object.entries(files)) {
          const safe = safePath(name);
          const fullPath = `${projectDir}/${safe}`;
          const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
          await sandbox.exec(`mkdir -p ${parent}`, { timeout: 30000 });
          await writeFileWithRetry(sandbox, fullPath, String(content));
        }

        const result = await sandbox.exec(runner(projectDir, activeFile), { timeout: 120000 });
        return json({
          engine: 'cloudflare-sandbox', language: extension,
          stdout: result.stdout || '', stderr: result.stderr || '',
          exitCode: result.exitCode, success: result.success,
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
