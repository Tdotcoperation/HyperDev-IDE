const LANGUAGE_MAP = {
  py: { id: 'python', label: 'Python', sandbox: false },
  js: { id: 'javascript', label: 'JavaScript', sandbox: true },
  mjs: { id: 'javascript', label: 'JavaScript', sandbox: true },
  java: { id: 'java', label: 'Java', sandbox: true },
  c: { id: 'c', label: 'C', sandbox: true },
  cpp: { id: 'cpp', label: 'C++', sandbox: true },
  cc: { id: 'cpp', label: 'C++', sandbox: true },
  go: { id: 'go', label: 'Go', sandbox: true },
  rs: { id: 'rust', label: 'Rust', sandbox: true },
};

const state = {
  editor: null,
  pyodide: null,
  pyodideReady: false,
  files: JSON.parse(localStorage.getItem('hyperdev-files') || 'null') || {
    'main.py': 'print("Hello from HyperDev IDE!")\n',
  },
  activeFile: localStorage.getItem('hyperdev-active-file') || 'main.py',
  models: new Map(),
  sessionId: localStorage.getItem('hyperdev-session-id') || crypto.randomUUID(),
};

localStorage.setItem('hyperdev-session-id', state.sessionId);

const outputEl = document.getElementById('output');
const engineStatusEl = document.getElementById('engineStatus');
const languageStatusEl = document.getElementById('languageStatus');
const fileListEl = document.getElementById('fileList');
const tabsEl = document.getElementById('tabs');
const runBtn = document.getElementById('runBtn');

function persist() {
  localStorage.setItem('hyperdev-files', JSON.stringify(state.files));
  localStorage.setItem('hyperdev-active-file', state.activeFile);
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function languageFor(name) {
  return LANGUAGE_MAP[ext(name)] || { id: 'plaintext', label: 'Plain Text', sandbox: false };
}

function writeOutput(text = '') {
  outputEl.textContent += String(text);
  outputEl.scrollTop = outputEl.scrollHeight;
}

function setOutput(text = '') {
  outputEl.textContent = String(text);
}

function saveActiveModel() {
  if (!state.editor || !state.activeFile) return;
  state.files[state.activeFile] = state.editor.getValue();
  persist();
}

function ensureModel(name) {
  if (state.models.has(name)) return state.models.get(name);
  const uri = monaco.Uri.parse(`file:///${name}`);
  const lang = languageFor(name).id;
  const model = monaco.editor.createModel(state.files[name] ?? '', lang, uri);
  model.onDidChangeContent(() => {
    if (state.activeFile === name) {
      state.files[name] = model.getValue();
      persist();
    }
  });
  state.models.set(name, model);
  return model;
}

function updateStatus() {
  const lang = languageFor(state.activeFile);
  languageStatusEl.textContent = lang.label;
}

function openFile(name) {
  if (state.files[name] === undefined) state.files[name] = '';
  saveActiveModel();
  state.activeFile = name;
  persist();
  state.editor.setModel(ensureModel(name));
  renderFiles();
  renderTabs();
  updateStatus();
  state.editor.focus();
}

function renderFiles() {
  fileListEl.innerHTML = '';
  Object.keys(state.files).sort().forEach((name) => {
    const item = document.createElement('div');
    item.className = `file-item${name === state.activeFile ? ' active' : ''}`;
    item.innerHTML = `<span class="file-dot"></span><span>${escapeHtml(name)}</span>`;
    item.addEventListener('click', () => openFile(name));
    fileListEl.appendChild(item);
  });
}

function renderTabs() {
  tabsEl.innerHTML = '';
  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.textContent = state.activeFile;
  tabsEl.appendChild(tab);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

async function initPyodide() {
  if (state.pyodideReady) return state.pyodide;
  engineStatusEl.textContent = 'Pyodide 로딩 중…';
  state.pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/' });
  state.pyodide.setStdout({ batched: (msg) => writeOutput(msg + '\n') });
  state.pyodide.setStderr({ batched: (msg) => writeOutput(msg + '\n') });
  state.pyodideReady = true;
  return state.pyodide;
}

function syncPyFiles(pyodide) {
  try { pyodide.FS.mkdir('/project'); } catch (_) {}
  Object.entries(state.files).forEach(([name, content]) => {
    pyodide.FS.writeFile(`/project/${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`, content, { encoding: 'utf8' });
  });
}

function pythonNeedsSandbox(code) {
  return [
    /(^|\n)\s*(import|from)\s+subprocess\b/m,
    /(^|\n)\s*(import|from)\s+socket\b/m,
    /(^|\n)\s*(import|from)\s+multiprocessing\b/m,
    /\bos\.system\s*\(/,
    /\bos\.popen\s*\(/,
    /\bsubprocess\./,
  ].some((r) => r.test(code));
}

function isPyodideEnvironmentError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return ['emscripten does not support processes', 'errno 138', 'not implemented in pyodide'].some((x) => text.includes(x));
}

async function runInSandbox() {
  engineStatusEl.textContent = '☁ Cloudflare Sandbox';
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: state.files, activeFile: state.activeFile, sessionId: state.sessionId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Sandbox 실행 실패 (HTTP ${response.status})`);
  setOutput('');
  if (result.stdout) writeOutput(result.stdout);
  if (result.stderr) writeOutput(result.stderr);
  if (!result.stdout && !result.stderr && result.success) writeOutput('실행이 완료되었습니다.\n');
  engineStatusEl.textContent = `☁ Sandbox · exit ${result.exitCode ?? '?'}`;
}

async function runCode() {
  saveActiveModel();
  setOutput('');
  runBtn.disabled = true;
  runBtn.textContent = '실행 중…';
  const lang = languageFor(state.activeFile);
  const code = state.files[state.activeFile] || '';

  try {
    if (lang.id !== 'python') {
      if (lang.id === 'plaintext') throw new Error('이 파일 형식은 아직 실행할 수 없습니다.');
      await runInSandbox();
      return;
    }

    if (pythonNeedsSandbox(code)) {
      setOutput('☁ 시스템 기능을 감지했습니다. Cloudflare Sandbox에서 실행합니다...\n\n');
      await runInSandbox();
      return;
    }

    try {
      const pyodide = await initPyodide();
      syncPyFiles(pyodide);
      await pyodide.runPythonAsync("import os,sys\nos.chdir('/project')\n'/project' not in sys.path and sys.path.insert(0,'/project')");
      await pyodide.runPythonAsync(code, { filename: state.activeFile });
      engineStatusEl.textContent = '● Browser / Pyodide';
    } catch (err) {
      if (isPyodideEnvironmentError(err)) await runInSandbox();
      else throw err;
    }
  } catch (err) {
    writeOutput(`${err?.message || String(err)}\n`);
    engineStatusEl.textContent = '실행 실패';
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ 실행';
  }
}

function createFile() {
  const raw = prompt('새 파일 이름', 'main.py');
  if (!raw) return;
  const name = raw.trim();
  if (!name) return;
  if (state.files[name] !== undefined) return alert('이미 같은 이름의 파일이 있습니다.');
  state.files[name] = '';
  persist();
  renderFiles();
  openFile(name);
}

function downloadCurrentFile() {
  saveActiveModel();
  const blob = new Blob([state.files[state.activeFile] || ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.activeFile;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
require(['vs/editor/editor.main'], function () {
  if (state.files[state.activeFile] === undefined) state.activeFile = Object.keys(state.files)[0] || 'main.py';
  if (state.files[state.activeFile] === undefined) state.files[state.activeFile] = '';
  state.editor = monaco.editor.create(document.getElementById('editor'), {
    model: ensureModel(state.activeFile), theme: 'vs-dark', automaticLayout: true,
    fontSize: 14, fontFamily: 'Consolas, "SFMono-Regular", Menlo, monospace',
    minimap: { enabled: true }, tabSize: 4, insertSpaces: true, scrollBeyondLastLine: false,
    smoothScrolling: true, cursorBlinking: 'smooth', bracketPairColorization: { enabled: true },
  });
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCode);
  state.editor.addCommand(monaco.KeyCode.F5, runCode);
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveModel);
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, downloadCurrentFile);
  renderFiles(); renderTabs(); updateStatus();
});

document.getElementById('newFileBtn').addEventListener('click', createFile);
document.getElementById('downloadBtn').addEventListener('click', downloadCurrentFile);
document.getElementById('clearOutputBtn').addEventListener('click', () => setOutput(''));
runBtn.addEventListener('click', runCode);
