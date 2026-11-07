#!/usr/bin/env node
// One real-page check through SSH-forwarded ports. No credentials are printed.
// Run on the Mac with 3081 and 3082 forwarded; sudo prompts on this terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORLD, readCompanionFiles } from './companion-sudo.mjs';
const modelMode = process.argv.includes('--model');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-browser-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let next = 0, stage = 'chrome-start', browserSocket, startupLog = '', access, activeSession;
const pending = new Map(), browserErrors = [];
const endpoint = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('CHROME_START_TIMEOUT')), 15000); chrome.stderr.on('data', bytes => { startupLog += bytes.toString(); const found = startupLog.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timeout); resolve(found[1]); } }); chrome.once('error', () => { clearTimeout(timeout); reject(new Error('CHROME_START_FAILED')); }); });
function call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++next; const timeout = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('CDP_TIMEOUT'), { method })); }, 20000); pending.set(id, { resolve, reject, timeout }); browserSocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
try {
  browserSocket = new WebSocket(await endpoint);
  await new Promise((resolve, reject) => { browserSocket.addEventListener('open', resolve, { once: true }); browserSocket.addEventListener('error', reject, { once: true }); });
  browserSocket.addEventListener('message', ({data}) => { const event = JSON.parse(data); if (event.method === 'Runtime.exceptionThrown') browserErrors.push((event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text).split('\n')[0].slice(0,300)); const entry = pending.get(event.id); if (!entry) return; pending.delete(event.id); clearTimeout(entry.timeout); event.error ? entry.reject(Object.assign(new Error('CDP_REQUEST_FAILED'), { detail: event.error.message })) : entry.resolve(event.result); });
  stage = 'access';
  const [web, operator] = await readCompanionFiles([WORLD + '/dsh-home/run/local-access.json', WORLD + '/operator/console.token']);
  access = { web: JSON.parse(web), operator: operator.trim() };
  stage = 'chrome-target';
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  activeSession = sessionId;
  await call('Page.enable', {}, sessionId);
  await call('Runtime.enable', {}, sessionId);
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async expression => { const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (response.exceptionDetails) throw new Error('PAGE_SCRIPT_FAILED'); return response.result.value; };
  const wait = expression => evaluate(`new Promise(resolve=>{const test=()=>!!(${expression});if(test())return resolve(true);const observer=new MutationObserver(()=>{if(test()){observer.disconnect();clearTimeout(timer);resolve(true);}});observer.observe(document,{childList:true,subtree:true,attributes:true,characterData:true});const timer=setTimeout(()=>{observer.disconnect();resolve(false);},15000);})`);
  stage = 'web-login';
  const login = new URL('/', access.web.origin); login.searchParams.set('token', access.web.token); login.hash = 'companion-operator=' + access.operator;
  await call('Page.navigate', { url: login.href }, sessionId);
  if (!await wait(`document.querySelectorAll('button').length>2 && !location.search.includes('token=')`)) throw new Error('WEB_NOT_READY');
  stage = 'first-run-notice';
  if (await wait(`document.body.innerText.includes('预览版说明') && [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='继续')`)) {
    await evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='继续').click();return true;})()`);
    if (!await wait(`!document.body.innerText.includes('预览版说明')`)) throw new Error('NOTICE_NOT_DISMISSED');
  }
  if (!await evaluate(`!!sessionStorage.getItem('companion-world:operator:v1') && !location.hash`)) throw new Error('AUTOMATIC_AUTH_FAILED');
  const labels = () => [...document.querySelectorAll('button,[role="button"]')].map(b => ({ text: b.innerText?.trim(), aria: b.getAttribute('aria-label'), title: b.getAttribute('title') })).filter(b => b.text || b.aria || b.title);
  stage = 'settings';
  const openSettings = `(()=>{const b=[...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].find(b=>/^(Settings|设置)(?:\\s|$)/.test((b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').trim()));if(b)b.click();return !!b;})()`;
  let opened = await evaluate(openSettings);
  if (!opened) {
    await evaluate(`(()=>{const menu=document.querySelector('[aria-label="账号菜单"],[aria-label="Account menu"]');menu?.click();return !!menu;})()`);
    await wait(`[...document.querySelectorAll('button,[role="menuitem"]')].some(b=>/Settings|设置/.test(b.innerText))`);
    opened = await evaluate(openSettings);
  }
  if (!opened) { console.log(JSON.stringify({ stage, visibleButtons: await evaluate('(' + labels.toString() + ')()') })); throw new Error('SETTINGS_NOT_FOUND'); }
  if (!await wait(`[...document.querySelectorAll('button')].some(b=>/大肥鱼世界|Companion world/.test(b.innerText))`)) throw new Error('CONSOLE_ENTRY_MISSING');
  await evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>/大肥鱼世界|Companion world/.test(b.innerText)).click();return true;})()`);
  stage = 'console-load';
  if (!await wait(`document.querySelector('.bff-world .bff-status')`)) { console.log(JSON.stringify({ stage, text: await evaluate("document.querySelector('.bff-world')?.innerText") })); throw new Error('CONSOLE_NOT_READY'); }
  if (!modelMode) {
  const pausedText = await evaluate("document.querySelector('.bff-status').innerText");
  stage = 'resume';
  await evaluate(`(()=>{[...document.querySelectorAll('.bff-world button')].find(b=>/^(Resume(?: world)?|恢复世界|恢复)$/.test(b.innerText.trim())).click();return true;})()`);
  if (!await wait(`document.querySelector('.bff-status') && document.querySelector('.bff-status').innerText!==${JSON.stringify(pausedText)} && [...document.querySelectorAll('.bff-world button')].some(b=>/Pause|暂停/.test(b.innerText)&&!b.disabled)`)) throw new Error('RESUME_NOT_APPLIED');
  stage = 'pause';
  await evaluate(`(()=>{[...document.querySelectorAll('.bff-world button')].find(b=>/^(Pause(?: world)?|暂停世界|暂停)$/.test(b.innerText.trim())).click();return true;})()`);
  if (!await wait(`document.querySelector('.bff-status')?.innerText===${JSON.stringify(pausedText)}`)) throw new Error('PAUSE_NOT_APPLIED');
  } else {
    stage = 'model-config';
    await evaluate(`(()=>{[...document.querySelectorAll('.bff-world nav button')].find(b=>/运行与设置|Runtime/.test(b.innerText)).click();return true;})()`);
    if (!await wait(`document.querySelector('.bff-world input[type=password]')`)) throw new Error('MODEL_FORM_MISSING');
    if (!await evaluate(`document.querySelector('.bff-world input[type=password]').value.length===0`)) throw new Error('KEY_WAS_ECHOED');
  }
  const screenshot = fileURLToPath(new URL(modelMode ? '../../.build/world-model-config-live.png' : '../../.build/world-console-live.png', import.meta.url));
  const image = await call('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(screenshot, Buffer.from(image.data, 'base64'));
  console.log(JSON.stringify({ realPageVerified: true, automaticAuthorization: true, modelConfiguration: modelMode, pauseResume: !modelMode, screenshot, renderedText: await evaluate("document.querySelector('.bff-world').innerText") }));
} catch (error) {
  if (activeSession && ['resume', 'pause', 'console-load'].includes(stage)) {
    const state = await call('Runtime.evaluate', { expression: "document.querySelector('.bff-world')?.innerText || document.body.innerText.slice(-3500)", returnByValue: true }, activeSession);
    console.log(JSON.stringify({ pageState: state.result.value, browserErrors }));
  }
  console.error(JSON.stringify({ verified: false, stage, ...(stage === 'chrome-start' || stage === 'chrome-target' ? { method: error.method, detail: error.detail, startup: startupLog.slice(-1600), exitCode: chrome.exitCode } : {}) })); process.exitCode = 1; }
finally {
  if (access && !modelMode) {
    const headers = { authorization: 'Bearer ' + access.operator, 'content-type': 'application/json' };
    const state = await (await fetch('http://127.0.0.1:3082/world', { headers })).json();
    if (!state.value.world.paused) await fetch('http://127.0.0.1:3082/world/pause', { method: 'POST', headers, body: JSON.stringify({ paused: true, expectedRevision: state.value.world.revision }) });
  }
  browserSocket?.close();
  chrome.kill('SIGTERM');
  for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('BROWSER_CLOSED')); }
  await new Promise(resolve => chrome.exitCode === null ? chrome.once('exit', resolve) : resolve());
  if (fs.realpathSync(profile).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'companion-browser-')) fs.rmSync(profile, { recursive: true, force: true });
}
