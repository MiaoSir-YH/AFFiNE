import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = resolve(process.argv[2]);
const profile = await mkdtemp(join(tmpdir(), 'affine-desktop-smoke-'));
const child = spawn(
  executable,
  [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--disable-gpu'],
  {
    cwd: dirname(executable),
    env: { ...process.env, APPDATA: profile, SKIP_ONBOARDING: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  }
);
let diagnostic = '';
let spawnError;
child.on('error', error => {
  spawnError = error;
});
child.stderr.on('data', data => {
  diagnostic = (diagnostic + data.toString()).slice(-8000);
});

async function hasDesktopSettings(endpoint) {
  const socket = new WebSocket(endpoint);
  try {
    return await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 2500);
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => {
                const entry = document.querySelector('[data-testid="settings-modal-trigger"]');
                if (!entry || typeof window.__apis?.desktopAI?.createSession !== 'function') return false;
                const settings = document.querySelector('[data-testid="setting-modal-content"]');
                if (!settings) entry.click();
                const providerTab = document.querySelector('[data-testid="desktop-ai-panel-trigger"]');
                const connect = document.querySelector('[data-testid="chatgpt-subscription-connect"]');
                const gateway = document.querySelector('[data-testid="desktop-ai-gateway-configure"]');
                if (providerTab && !gateway) providerTab.click();
                return Boolean(connect && gateway);
              })()`,
            },
          })
        );
      });
      socket.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id === 1) {
          clearTimeout(timeout);
          resolve(response.result?.result?.value === true);
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  } finally {
    socket.close();
  }
}

try {
  const deadline = Date.now() + 90000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`AFFiNE exited with ${child.exitCode}\n${diagnostic}`);
    }
    const portFile = await readFile(
      join(profile, 'DevToolsActivePort'),
      'utf8'
    ).catch(() => '');
    const portLog = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(
      diagnostic
    );
    const port = portFile.split(/\r?\n/)[0] || portLog?.[1];
    if (port) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
        .then(response => response.json())
        .catch(() => []);
      const candidates = targets.filter(
        target =>
          target.url.startsWith('assets:') && target.webSocketDebuggerUrl
      );
      for (const target of candidates) {
        if (await hasDesktopSettings(target.webSocketDebuggerUrl)) {
          ready = true;
          break;
        }
      }
    }
    if (!ready) await delay(300);
  }
  if (!ready) {
    throw new Error(
      `AFFiNE did not open its AI provider settings\n${diagnostic}`
    );
  }
  console.log(
    'AFFiNE.exe opened its packaged renderer and displayed both AI provider options.'
  );
} finally {
  child.kill();
}
