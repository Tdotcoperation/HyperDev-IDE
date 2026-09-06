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

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function ext(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/run') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });

      try {
        const body = (await request.json()) as RunPayload;
        const files = body.files || {};
        const requestedActiveFile = body.activeFile || '';
        if (!requestedActiveFile || files[requestedActiveFile] === undefined) {
          return json({ error: '실행할 파일이 없습니다.' }, { status: 400 });
        }

        const activeFile = safeFileName(requestedActiveFile);
        const extension = ext(activeFile);
        const runner = RUNNERS[extension];
        if (!runner) return json({ error: `지원하지 않는 실행 형식입니다: .${extension || '(없음)'}` }, { status: 400 });

        const session = safeFileName(body.sessionId || crypto.randomUUID());
        const sandbox = getSandbox(env.Sandbox, `hyperdev-${session}`);
        const projectDir = '/workspace/hyperdev-project';
        await sandbox.exec(`mkdir -p ${projectDir}`, { timeout: 30000 });

        for (const [name, content] of Object.entries(files)) {
          await writeFileWithRetry(sandbox, `${projectDir}/${safeFileName(name)}`, String(content));
        }

        const result = await sandbox.exec(runner(projectDir, activeFile), { timeout: 120000 });
        return json({
          engine: 'cloudflare-sandbox',
          language: extension,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: result.exitCode,
          success: result.success,
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
