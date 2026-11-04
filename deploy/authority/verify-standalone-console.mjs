#!/usr/bin/env node
// Read-only real-page smoke check. CLI capture avoids debugger target creation;
// form semantics are covered separately by UI tests and real operator APIs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fish-console-browser-')));
let chrome;
try {
  const remote = `const fs=require('fs'),os=require('os');process.stdout.write(fs.readFileSync(os.homedir()+'/.local/share/companion-world-v1/operator/console.token','utf8').trim());`;
  const token = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'myvm', '"$HOME/.local/opt/companion/bin/node" -e ' + JSON.stringify(remote)], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('ACCESS');
  const screenshot = path.resolve('projects/big-fat-fish/.build/standalone-console-live.png');
  const url = 'http://127.0.0.1:3082/#companion-operator=' + token;
  const output = await new Promise((resolve, reject) => {
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, '--window-size=1360,1000', '--timeout=20000', '--virtual-time-budget=15000', '--screenshot=' + screenshot, '--dump-dom', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let dom = '';
    const timer = setTimeout(() => { chrome.kill('SIGKILL'); reject(Error('BROWSER_TIMEOUT')); }, 35000);
    chrome.stdout.setEncoding('utf8'); chrome.stdout.on('data', chunk => { dom += chunk; if (dom.length > 2 * 1024 * 1024) { chrome.kill('SIGKILL'); reject(Error('BROWSER_OUTPUT_LIMIT')); } });
    chrome.stderr.resume();
    chrome.once('error', () => { clearTimeout(timer); reject(Error('BROWSER_START')); });
    chrome.once('close', code => { clearTimeout(timer); if (code !== 0) reject(Error('BROWSER_EXIT')); else resolve(dom); });
  });
  const status = /class="bff-status"[^>]*>([^<]*)</.exec(output)?.[1] || '';
  const checks = { actualStandalonePage: /class="bff-world"/.test(output), authenticatedOverviewVisible: Boolean(status), worldPausedVisible: /暂停|Paused/i.test(status), credentialNotInDom: !output.includes(token), screenshotCreated: fs.existsSync(screenshot), dshSessionCreationAbsent: !/创建DSH测试对话/.test(output) };
  console.log(JSON.stringify({ checks, screenshot, mutationPerformed: false, scope: 'actual overview render; no real parameter edits, reference uploads or delete clicks' }));
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ verified: false, code: /^[A-Z_]+$/.test(error.message || '') ? error.message : 'BROWSER_VERIFY_FAILED' })); process.exitCode = 1; }
finally {
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGKILL'); await new Promise(resolve => chrome.once('exit', resolve)); }
  if (path.dirname(profile) !== fs.realpathSync(os.tmpdir()) || !path.basename(profile).startsWith('fish-console-browser-')) throw Error('BROWSER_PROFILE_PATH');
  fs.rmSync(profile, { recursive: true });
}
