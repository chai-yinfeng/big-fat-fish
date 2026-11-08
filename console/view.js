// Shared UI for the standalone browser entry. Styling lives in standalone.css.
import React from 'react';
import DICTIONARIES from './dictionaries.js';
import { TOKEN_KEY, operatorRequest, personaDraft, personaPatch, personaExport, personaImport, validWorld, validQQ, qqPayload, modelPayload } from './operator-client.js';
import { validRuntime, speechPayload, readReferenceFile, referencePayload, voiceTestBlob } from './runtime-client.js';
const h = React.createElement;
const { useState, useRef, useEffect } = React;
const NS = 'companion.world';
const VOICE_DRAFT = { voiceId: '', label: '', language: 'ja', usageScope: 'private' };
// Only a display preference; never secrets or world content.
const THEME_KEY = 'companion-world:theme';
// Data-driven navigation: a new page adds one entry here and one renderer below.
// `key` is the G+letter shortcut.
const NAV = [
  { id: 'overview', icon: 'overview', key: 'O' },
  { id: 'persona', icon: 'persona', key: 'P' },
  { id: 'channels', icon: 'channels', key: 'C' },
  { id: 'memory', icon: 'memory', key: 'M' },
  { id: 'runtime', icon: 'runtime', key: 'R' },
];
// Inline icon geometry (24px grid, Lucide-style strokes) so the page needs no icon font or CDN.
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rect = (x, y, w, hh, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${hh - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - hh}a${r} ${r} 0 0 1 ${r} ${-r}z`;
const ICONS = {
  overview: [rect(3, 3, 7, 9, 1), rect(14, 3, 7, 5, 1), rect(14, 12, 7, 9, 1), rect(3, 16, 7, 5, 1)],
  persona: [circle(12, 8, 5), 'M20 21a8 8 0 0 0-16 0'],
  channels: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  memory: ['M12 7v14', 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'],
  runtime: ['M20 7h-9', 'M14 17H5', circle(17, 17, 3), circle(7, 7, 3)],
  fish: ['M2 12c2.5-4.5 6.5-6.5 11-5.5 2 .5 3.6 1.7 5 3.3L22 7v10l-4-2.8c-1.4 1.6-3 2.8-5 3.3-4.5 1-8.5-1-11-5.5z', 'M7 11.5v.01'],
  search: [circle(11, 11, 8), 'm21 21-4.3-4.3'],
  command: ['M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  sun: [circle(12, 12, 4), 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  monitor: [rect(2, 3, 20, 14, 2), 'M8 21h8', 'M12 17v4'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  pause: [rect(6, 4, 4, 16, 1), rect(14, 4, 4, 16, 1)],
  play: ['M6 3 20 12 6 21 6 3z'],
  save: ['M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7', 'M7 3v4a1 1 0 0 0 1 1h7'],
  plus: ['M5 12h14', 'M12 5v14'],
  up: ['m5 12 7-7 7 7', 'M12 19V5'],
  down: ['M12 5v14', 'm19 12-7 7-7-7'],
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  reset: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  eye: ['M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0', circle(12, 12, 3)],
  check: ['M20 6 9 17l-5-5'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: [circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
  volume: ['M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z', 'M16 9a5 5 0 0 1 0 6', 'M19.36 18.36a9 9 0 0 0 0-12.72'],
  star: ['M11.5 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.1 2.1 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.1 2.1 0 0 0-.6 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.1 2.1 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.1 2.1 0 0 0-.6-1.88L2.16 9.8a.53.53 0 0 1 .3-.9l5.16-.76a2.1 2.1 0 0 0 1.6-1.16z'],
  pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],
  chevron: ['m9 18 6-6-6-6'],
  cpu: [rect(4, 4, 16, 16, 2), rect(9, 9, 6, 6, 1), 'M15 2v2', 'M15 20v2', 'M2 15h2', 'M2 9h2', 'M20 15h2', 'M20 9h2', 'M9 2v2', 'M9 20v2'],
  lock: [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 10 0v4'],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  sparkles: ['M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z'],
  note: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  mic: [rect(9, 2, 6, 13, 3), 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  image: [rect(3, 3, 18, 18, 2), circle(9, 9, 2), 'm21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
};
function icon(name, className = 'bff-ic') {
  return h('svg', { className, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false' }, ...(ICONS[name] || []).map(d => h('path', { d })));
}
const kbd = label => h('span', { className: 'bff-kbd' }, label);
const badge = (label, tone = '', extra = null) => h('span', { className: `bff-badge ${tone}` }, extra, label);
const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl';
function readTheme() { try { const value = localStorage.getItem(THEME_KEY); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; } }
function systemDark() { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return true; } }
export function WorldConsole({ t, standalone = false }) {
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } });
  const [input, setInput] = useState('');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modelName, setModelName] = useState('deepseek-flash');
  const apiKeyInput = useRef(null);
  const [qq, setQQ] = useState(null);
  const qqCallerInput = useRef(null);
  const [memory, setMemory] = useState(null);
  const [forgetPreview, setForgetPreview] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [speechDraft, setSpeechDraft] = useState(null);
  const [audioTest, setAudioTest] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState(VOICE_DRAFT);
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const requests = useRef(new Set());
  const referenceFileInput = useRef(null);
  const referenceTranscriptInput = useRef(null);
  const referenceConsentInput = useRef(null);
  const audioObjectURL = useRef(null);
  const [personaPreview, setPersonaPreview] = useState(null);
  // Shell-only state (appended so existing hook order is unchanged).
  const [theme, setTheme] = useState(readTheme);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(null);
  const keyHandler = useRef(null);
  const gPressedAt = useRef(0);
  function clearReferenceInputs() {
    if (referenceFileInput.current) referenceFileInput.current.value = '';
    if (referenceTranscriptInput.current) referenceTranscriptInput.current.value = '';
    if (referenceConsentInput.current) referenceConsentInput.current.checked = false;
  }
  function clearAudio() {
    if (audioObjectURL.current) URL.revokeObjectURL(audioObjectURL.current);
    audioObjectURL.current = null; setAudioTest(null);
  }
  useEffect(() => () => { if (audioObjectURL.current) URL.revokeObjectURL(audioObjectURL.current); }, []);
  useEffect(() => { if (tab !== 'runtime') { clearAudio(); clearReferenceInputs(); setConfirmRemove(false); } }, [tab]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; for (const controller of requests.current) controller.abort(); }; }, []);
  function forget() {
    generation.current++;
    for (const controller of requests.current) controller.abort();
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    if (apiKeyInput.current) apiKeyInput.current.value = '';
    if (qqCallerInput.current) qqCallerInput.current.value = '';
    clearAudio(); clearReferenceInputs();
    setToken(''); setInput(''); setData(null); setDraft(null); setQQ(null); setMemory(null); setForgetPreview(null); setRuntimeInfo(null); setSpeechDraft(null); setConfirmRemove(false); setNotice('');
    setPalette(null); setDrawer(false);
  }
  async function request(path, payload, credential = token) {
    const controller = new AbortController();
    requests.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), path === '/voice/test' ? 240000 : path === '/model/test' ? 60000 : 12000);
    try { return await operatorRequest({ location: window.location, token: credential, path, payload, signal: controller.signal, sameOrigin: standalone }); }
    finally { clearTimeout(timeout); requests.current.delete(controller); }
  }
  function describeError(caught) {
    const key = caught.code || 'network';
    return t(`errors.${Object.hasOwn(DICTIONARIES.en.errors, key) ? key : 'request_failed'}`);
  }
  async function run(action) {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (caught) {
      if (!mounted.current || generation.current !== current) return;
      // Keep the loaded world on screen; only an authorization failure clears state.
      clearAudio(); clearReferenceInputs();
      if (caught.code === 'authorization_required') forget();
      setError(describeError(caught));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function load(credential = token) {
    const current = generation.current;
    const value = await request('/world', undefined, credential);
    if (!validWorld(value)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    if (!mounted.current || generation.current !== current) return;
    setData(value); setDraft(personaDraft(value.persona.value)); setPersonaPreview(null); setModelName(value.model.model || 'deepseek-flash');
  }
  async function loadQQ(credential = token) {
    const current = generation.current;
    const value = await request('/qq', undefined, credential);
    if (!validQQ(value)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    if (!mounted.current || generation.current !== current) return;
    setQQ({ loggedIn: value.loggedIn, connected: value.connected, configured: value.configured, callerConfigured: value.callerConfigured, paused: value.paused });
  }
  async function loadRuntime(credential = token) {
    const current = generation.current, value = await request('/runtime', undefined, credential);
    if (!validRuntime(value)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    if (!mounted.current || generation.current !== current) return;
    setRuntimeInfo(value); setSpeechDraft(value.speech.status === 'ready' ? { numThreads: value.speech.numThreads, maxTextChars: value.speech.maxTextChars } : null);
  }
  useEffect(() => { if (token) void run(async () => { await load(token); if (standalone && tab === 'runtime') await loadRuntime(token); }); }, [token]);
  useEffect(() => { if (token && tab === 'channels') void run(() => loadQQ(token)); }, [token, tab]);
  useEffect(() => { if (standalone && token && tab === 'runtime') void run(() => loadRuntime(token)); }, [tab]);
  // Shell effects: theme attribute, toast lifetime, scroll reset, global shortcuts.
  useEffect(() => {
    try {
      if (theme === 'system') { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem(THEME_KEY); }
      else { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem(THEME_KEY, theme); }
    } catch {}
  }, [theme]);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { try { window.scrollTo(0, 0); } catch {} }, [tab]);
  useEffect(() => {
    const listener = event => keyHandler.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const button = (key, onClick, extra = {}) => {
    const { icon: name, ...props } = extra;
    return h('button', { type: 'button', disabled: busy, onClick, ...props }, name ? icon(name) : null, t(key));
  };
  const text = key => h('p', { className: 'bff-muted' }, t(key));
  const alert = (tone, content, props = {}) => h('div', { className: `bff-alert ${tone}`, ...props }, icon(tone === 'info' ? 'info' : 'alert'), h('p', null, content));
  const statusLine = (label, tone) => h('p', { role: 'status', className: 'bff-row' }, badge(label, tone, h('span', { className: 'bff-dot' })));
  const cardHead = (title, ...actions) => h('div', { className: 'bff-card-head' }, title, actions.some(Boolean) ? h('div', { className: 'bff-actions' }, ...actions) : null);
  const effectiveTheme = theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;
  const toggleTheme = () => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark');
  function go(key) {
    if (key !== 'memory') { setMemory(null); setForgetPreview(null); }
    setTab(key); setDrawer(false);
  }
  const refreshAll = () => run(async () => { await load(); if (standalone && tab === 'runtime') await loadRuntime(); });
  function field(key, multiline = false) {
    return h('label', { key }, h('span', null, t(key)), h(multiline ? 'textarea' : 'input', {
      name: key, value: draft[key], disabled: busy, rows: multiline ? 3 : undefined, onChange: event => setDraft({ ...draft, [key]: event.target.value }),
    }));
  }
  function time(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  const worldBadge = () => data.world.paused ? badge(t('paused'), 'warn', icon('pause')) : badge(t('running'), 'ok', h('span', { className: 'bff-dot pulse' }));
  const channelStatus = channel => channel.id === 'qq' && ['not_configured', 'waiting_login', 'ready', 'disconnected', 'error'].includes(channel.status) ? `qqChannelStatus.${channel.status}` : channel.status === 'available' ? 'available' : channel.status === 'not_configured' ? 'not_configured' : 'unknown';
  const channelTone = channel => ['ready', 'available'].includes(channel.status) ? 'ok' : ['disconnected', 'error'].includes(channel.status) ? 'danger' : channel.status === 'waiting_login' ? 'warn' : '';
  function overview() {
    return h(React.Fragment, null,
      h('section', { className: 'bff-card bff-world-card' },
        h('div', { className: 'bff-spread' },
          h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile bff-logo' }, icon('fish')),
            h('div', { className: 'bff-row' }, h('h2', null, t('title')), worldBadge())),
          button(data.world.paused ? 'resume' : 'pause', () => run(async () => {
            await request('/world/pause', { paused: !data.world.paused }); await load(); setNotice(t('saved'));
          }), { icon: data.world.paused ? 'play' : 'pause', className: data.world.paused ? 'bff-primary' : '' })),
        h('hr'),
        h('dl', { className: 'bff-kv' }, ...['worldTime', 'realTime', 'revision', 'personaRevision'].map((key, index) => h('div', { key },
          h('dt', null, t(key)), h('dd', { className: index < 2 ? '' : 'bff-mono' }, index === 0 ? time(data.world.worldNow) : index === 1 ? time(data.world.realNow) : index === 2 ? data.world.revision : data.persona.revision)))),
        alert('info', t('pauseHint'))),
      h('div', { className: 'bff-grid' }, ...[['facts', 'note'], ['notes', 'pin'], ['experiences', 'sparkles'], ['pending', 'inbox']].map(([key, name]) => h('dl', { key, className: 'bff-card bff-stat' },
        h('dt', null, icon(name), t(key)), h('dd', null, data.counts[key])))),
      data.channels.length > 0 && h('section', { className: 'bff-card' }, cardHead(h('h2', null, t('channels')), button('shell.manage', () => go('channels'), { className: 'bff-ghost bff-sm', icon: 'chevron' })),
        h('div', null, ...data.channels.map(channel => h('div', { className: 'bff-list-row', key: channel.id }, h('span', { className: 'bff-tile' }, icon('channels')),
          h('div', { className: 'bff-grow' }, h('div', { className: 'bff-row' }, h('strong', null, channel.name || channel.id), badge(t(channelStatus(channel)), channelTone(channel))),
            h('p', { className: 'bff-small bff-muted' }, `${t(channel.enabled ? 'enabled' : 'disabled')} · ${t('boundStreams')}: ${channel.boundStreams}`)))))),
      text('snapshot'));
  }
  function persona() {
    const dirty = JSON.stringify(draft) !== JSON.stringify(personaDraft(data.persona.value));
    return h('form', { className: 'bff-stack', onSubmit: event => { event.preventDefault(); void run(async () => {
      await request('/persona', { patch: personaPatch(draft) }); await load(); setNotice(t('saved'));
    }); } },
    h('div', { className: 'bff-persona' },
      h('div', { className: 'bff-stack' },
        h('section', { className: 'bff-card' }, cardHead(h('div', null, h('h2', null, `${t('personaRevision')}: ${data.persona.revision}`), text('arrayHint'))),
          h('div', { className: 'bff-form-grid' }, ...['name', 'userCallName', 'relationshipStage'].map(key => field(key))),
          text('personaPanel.neutralHint'),
          field('identity', true),
          h('div', { className: 'bff-form-grid' }, ...['traits', 'speechStyle', 'boundaries', 'principles'].map(key => field(key, true)))),
        personaExamples()),
      h('div', { className: 'bff-stack bff-sticky' }, personaPreviewCard(), personaFiles())),
    h('div', { className: 'bff-savebar' },
      dirty ? badge(t('personaPanel.unsaved'), 'warn', h('span', { className: 'bff-dot' })) : null,
      h('p', { className: 'bff-grow' }, t('conflictHint')),
      button('discard', () => setDraft(personaDraft(data.persona.value)), { className: 'bff-ghost' }),
      h('button', { type: 'submit', disabled: busy }, icon('save'), t('save'))));
  }
  function personaExamples() {
    const examples = draft.examples;
    const change = next => setDraft({ ...draft, examples: next });
    const move = (from, to) => { const next = [...examples]; next.splice(to, 0, next.splice(from, 1)[0]); change(next); };
    return h('fieldset', { className: 'bff-card' }, h('legend', { className: 'bff-sr-only' }, t('personaPanel.examples')),
      cardHead(h('h2', { 'aria-hidden': true }, t('personaPanel.examples'), ' ', badge(String(examples.length)))),
      examples.length ? null : h('div', { className: 'bff-empty' }, icon('channels'), h('p', null, t('personaPanel.noExamples'))),
      ...examples.map((entry, index) => h('div', { key: index, className: 'bff-example' },
        h('div', { className: 'bff-spread' }, h('span', { className: 'bff-small bff-subtle bff-mono' }, `#${index + 1}`),
          h('div', { className: 'bff-actions' },
            button('personaPanel.moveUp', () => move(index, index - 1), { disabled: busy || index === 0, className: 'bff-ghost bff-sm', icon: 'up' }),
            button('personaPanel.moveDown', () => move(index, index + 1), { disabled: busy || index === examples.length - 1, className: 'bff-ghost bff-sm', icon: 'down' }),
            button('personaPanel.removeExample', () => change(examples.filter((_, i) => i !== index)), { className: 'bff-danger-ghost bff-sm', icon: 'trash' }))),
        ...['user', 'assistant'].map(side => h('label', { key: side }, h('span', null, `${index + 1}. ${t(side === 'user' ? 'personaPanel.exampleUser' : 'personaPanel.exampleAssistant')}`),
          h('textarea', { name: `example-${index}-${side}`, value: entry[side], rows: 2, disabled: busy, onChange: event => change(examples.map((item, i) => i === index ? { ...item, [side]: event.target.value } : item)) }))))),
      h('div', { className: 'bff-actions' }, button('personaPanel.addExample', () => change([...examples, { user: '', assistant: '' }]), { className: 'bff-sm', icon: 'plus' })));
  }
  function personaPreviewCard() {
    const source = JSON.stringify(personaPatch(draft));
    const current = personaPreview?.source === source ? personaPreview : null;
    return h('section', { className: 'bff-card' }, cardHead(h('div', null, h('h2', null, t('personaPanel.previewTitle')), text('personaPanel.previewHint'))),
      h('div', { className: 'bff-actions' }, button('personaPanel.preview', () => run(async () => {
        const value = await request('/persona/preview', { patch: JSON.parse(source) });
        setPersonaPreview({ source, text: value.text, chars: value.chars, limit: value.limit });
      }), { className: 'bff-sm', icon: 'eye' })),
      current && h(React.Fragment, null,
        h('div', { className: 'bff-spread bff-small' }, h('span', { className: 'bff-muted' }, t('personaPanel.previewCount')), h('span', { className: 'bff-mono' }, `${current.chars} / ${current.limit}`)),
        h('div', { className: `bff-progress ${current.chars > current.limit ? 'over' : ''}`, 'aria-hidden': true }, h('i', { style: { width: `${Math.min(100, current.limit > 0 ? current.chars / current.limit * 100 : 100)}%` } })),
        current.chars > current.limit ? alert('danger', t('personaPanel.previewTruncated'), { role: 'alert' }) : h('p', { className: 'bff-row bff-muted' }, badge(t('personaPanel.previewFits'), 'ok', icon('check'))),
        h('textarea', { className: 'bff-preview', readOnly: true, value: current.text, rows: 16, 'aria-label': t('personaPanel.previewTitle') })));
  }
  function personaFiles() {
    function exportJSON() {
      const url = URL.createObjectURL(new Blob([personaExport(draft)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `persona-${(draft.name || 'persona').replace(/[^\p{L}\p{N}_-]+/gu, '_')}-r${data.persona.revision}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    async function importJSON(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      setError(''); setNotice('');
      try {
        if (file.size > 98304) throw new Error('too large');
        setDraft(personaImport(await file.text(), data.persona.default)); setNotice(t('personaPanel.imported'));
      } catch { setError(t('personaPanel.invalidFile')); }
    }
    return h('section', { className: 'bff-card' }, text('personaPanel.importHint'),
      h('div', { className: 'bff-actions' },
        button('personaPanel.export', exportJSON, { className: 'bff-ghost bff-sm', icon: 'download' }),
        h('label', { className: 'bff-file-btn' }, icon('upload'), h('span', null, t('personaPanel.import')), h('input', { type: 'file', className: 'bff-sr-only', accept: 'application/json,.json', disabled: busy, onChange: event => { void importJSON(event); } })),
        data.persona.default && button('personaPanel.loadDefault', () => { setDraft(personaDraft(data.persona.default)); setNotice(t('personaPanel.defaultLoaded')); }, { className: 'bff-ghost bff-sm', icon: 'reset' })));
  }
  function qqSettings() {
    const gated = busy || !qq?.loggedIn || !qq?.paused || !data.world.paused;
    return h('section', { className: 'bff-card' }, cardHead(h('div', null, h('h2', null, t('qqTitle')), text('qqPrivateHint')),
      button('qqRefresh', () => run(async () => { await loadQQ(); await load(); }), { className: 'bff-ghost bff-sm', icon: 'refresh' })),
      !qq ? text('qqStatusPending') : h(React.Fragment, null,
        h('div', { role: 'status', className: 'bff-actions' }, badge(t(qq.loggedIn ? 'qqLoggedIn' : 'qqWaitingLogin'), qq.loggedIn ? 'ok' : 'warn', h('span', { className: 'bff-dot' })),
          badge(t(qq.connected ? 'qqConnected' : 'qqDisconnected'), qq.connected ? 'ok' : 'danger', h('span', { className: 'bff-dot' }))),
        h('div', { className: 'bff-stack-sm' }, text(qq.configured ? 'qqConfigured' : 'qqNotConfigured'), text(qq.callerConfigured ? 'qqCallerConfigured' : 'qqCallerMissing'), text(qq.paused ? 'qqPaused' : 'qqRunning')),
        !qq.loggedIn && alert('info', t('qqLoginHint')),
        (!data.world.paused || !qq.paused) && alert('warn', t('qqPauseRequired')),
        h('form', { onSubmit: event => { event.preventDefault(); if (!qq.loggedIn || !qq.paused || !data.world.paused) return; void run(async () => {
          await request('/qq', qqPayload(qqCallerInput.current?.value || ''));
          if (qqCallerInput.current) qqCallerInput.current.value = '';
          await loadQQ(); await load(); setNotice(t('saved'));
        }); } },
        h('label', null, h('span', null, t('qqCallerUID')), h('input', { ref: qqCallerInput, type: 'text', inputMode: 'numeric', pattern: '[0-9]+', required: true, disabled: gated, autoComplete: 'off', spellCheck: false })),
        text('qqCallerHint'), text('qqCallerPrivacy'),
        h('button', { type: 'submit', disabled: gated }, t('qqSave')))));
  }
  function channels() {
    return h(React.Fragment, null,
      data.channels.length ? h('section', { className: 'bff-card' }, ...data.channels.map(channel => h('div', { className: 'bff-list-row', key: channel.id },
        h('span', { className: 'bff-tile' }, icon('channels')),
        h('div', { className: 'bff-grow' }, h('div', { className: 'bff-row' }, h('h2', null, channel.name || channel.id), h('code', { className: 'bff-subtle' }, channel.id)),
          h('p', { className: 'bff-small bff-muted' }, `${t(channel.enabled ? 'enabled' : 'disabled')} · ${t('boundStreams')}: ${channel.boundStreams}`)),
        badge(t(channelStatus(channel)), channelTone(channel), h('span', { className: 'bff-dot' }))))) : text('noChannels'),
      qqSettings(),
      h('section', { className: 'bff-card' }, h('h2', null, t('channels')), data.bindings.length ? h('div', { className: 'bff-table' }, h('table', null,
        h('thead', null, h('tr', null, ...['source', 'conversation', 'person', 'audience'].map(key => h('th', { key, scope: 'col' }, t(key))))),
        h('tbody', null, ...data.bindings.map((binding, index) => h('tr', { key: binding.sourceId === 'qq' ? `qq:${index}` : `${binding.sourceId}:${binding.conversationId}:${index}` },
          ...['sourceId', 'conversationId', 'personId', 'audience'].map(key => h('td', { key, className: key === 'personId' ? 'bff-mono' : '' }, binding.sourceId === 'qq' && key === 'conversationId' ? t('qqPrivateConversation') : String(binding[key] ?? '—')))))))) : text('noBindings')));
  }
  function modelSettings() {
    const model = data.model;
    const allowed = ['deepseek-flash', 'deepseek-v4-pro'].includes(modelName.trim());
    return h('section', { className: 'bff-card' }, cardHead(h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile' }, icon('cpu')), h('h2', null, t('model')))),
      statusLine(t(`modelStatus.${model.status}`), model.status === 'verified' ? 'ok' : model.status === 'error' ? 'danger' : model.status === 'unconfigured' ? 'warn' : 'primary'),
      text('modelHint'),
      model.lastTest && h('p', { className: 'bff-small' }, `${t('modelLastTest')}: ${time(model.lastTest.at)} · ${t(model.lastTest.ok ? 'modelTestPassed' : 'modelTestFailed')}`),
      h('form', { onSubmit: event => { event.preventDefault(); if (!data.world.paused || !['deepseek-flash', 'deepseek-v4-pro'].includes(modelName.trim())) return; void run(async () => {
        const payload = modelPayload(modelName, apiKeyInput.current?.value || '');
        if (apiKeyInput.current) apiKeyInput.current.value = '';
        await request('/model', payload);
        await load(); setNotice(t('saved'));
      }); } },
      h('div', { className: 'bff-form-grid' },
        h('label', null, h('span', null, t('modelName')), h('input', { value: modelName, disabled: busy, required: true, pattern: 'deepseek-(flash|v4-pro)', autoComplete: 'off', spellCheck: false,
          onChange: event => setModelName(event.target.value) })),
        h('label', null, h('span', null, t('modelApiKey')), h('input', { ref: apiKeyInput, type: 'password', disabled: busy, autoComplete: 'off', spellCheck: false, autoCapitalize: 'none' }))),
      text(model.configured ? 'modelKeyKeep' : 'modelKeyRequired'), text('modelKeyPrivacy'),
      !data.world.paused && alert('warn', t('modelPauseRequired')),
      h('button', { type: 'submit', disabled: busy || !data.world.paused || !allowed }, icon('save'), t('modelSave'))),
      h('hr'),
      text('modelTestHint'),
      h('div', { className: 'bff-actions' }, button('modelTest', () => run(async () => {
        const result = await request('/model/test', {});
        if (typeof result?.ok !== 'boolean' || typeof result.model !== 'string') throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
        await load(); setNotice(t(result.ok ? 'modelTestPassed' : 'modelTestFailed'));
      }), { disabled: busy || !model.configured, icon: 'sparkles' })));
  }
  async function loadMemory() {
    const value = await request('/memory');
    if (!value || typeof value.entityId !== 'string' || !Array.isArray(value.items) || !Array.isArray(value.diaries)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    setMemory(value);
  }
  function dialog(title, body, actions, onCancel) {
    // Modal confirmation: backdrop click and Escape cancel unless a request is running.
    return h('div', { className: 'bff-overlay', onClick: event => { if (event.target === event.currentTarget && !busy) onCancel(); } },
      h('section', { className: 'bff-dialog', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'bff-dialog-title' },
        h('h3', { id: 'bff-dialog-title' }, title), ...body, h('div', { className: 'bff-actions' }, ...actions)));
  }
  function memories() {
    const mutate = (path, payload) => run(async () => { await request(path, payload); await loadMemory(); setNotice(t('saved')); });
    const preview = id => button('memoryForgetPreview', () => run(async () => { setForgetPreview(await request('/memory/forget-preview', { entityId: memory.entityId, ids: [id] })); }), { className: 'bff-danger-ghost bff-sm', icon: 'trash' });
    return h(React.Fragment, null,
      h('section', { className: 'bff-card' }, cardHead(h('h2', null, t('memoryTitle')),
        button('memoryReadExplicitly', () => run(loadMemory), { className: 'bff-primary bff-sm', icon: 'eye' }),
        button('memoryCleanupRefresh', () => run(async () => { const jobs = await request('/memory/cleanup/pending'); setNotice(t(jobs.length ? 'memoryCleanupPending' : 'memoryCleanupComplete')); }), { className: 'bff-ghost bff-sm', icon: 'refresh' })),
        alert('info', t('memoryPrivacy')), text('memoryLifecycle'),
        memory && h('p', { className: 'bff-small bff-muted' }, `${t('memoryEntity')}: `, h('code', null, memory.entityId))),
      memory && h(React.Fragment, null,
        ...memory.items.map(item => h('article', { className: 'bff-card bff-memory', key: item.id },
          h('div', { className: 'bff-actions' }, badge(item.type, 'primary'), badge(item.status), item.pinned ? badge(t('memoryPinned'), 'primary', icon('pin')) : null),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, item.summary || item.text || `${item.key || ''}: ${item.value || ''}`),
          h('form', { onSubmit: event => { event.preventDefault(); const value = event.currentTarget.elements.eventAt.value; const eventAt = value ? Date.parse(value) : null; if (eventAt !== null && !Number.isFinite(eventAt)) return; void mutate('/memory/retention', { entityId: memory.entityId, id: item.id, eventAt }); } },
            h('label', null, h('span', null, t('memoryEventTime')), h('input', { name: 'eventAt', type: 'datetime-local', disabled: busy, defaultValue: item.eventAt == null ? '' : new Date(item.eventAt - new Date(item.eventAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) })),
            button('memorySaveEventTime', undefined, { type: 'submit', className: 'bff-secondary bff-sm', icon: 'clock' })),
          h('div', { className: 'bff-actions' },
            button(item.pinned ? 'memoryUnpin' : 'memoryPin', () => mutate('/memory/retention', { entityId: memory.entityId, id: item.id, pinned: !item.pinned }), { className: 'bff-ghost bff-sm', icon: 'pin' }),
            item.visibility !== 'public' && item.kind !== 'inner' && button('memoryPublicAuthorize', () => mutate('/memory/public', { entityId: memory.entityId, id: item.id }), { className: 'bff-ghost bff-sm', icon: 'shield' }),
            preview(item.id)))),
        ...memory.diaries.map(diary => h('article', { className: 'bff-card bff-memory', key: diary.id },
          h('div', { className: 'bff-actions' }, badge(t(diary.kind === 'private' ? 'memoryPrivateDiary' : diary.status === 'published' ? 'memoryPublishedDiary' : 'memoryPublicDraft'), diary.kind === 'private' ? '' : 'primary', icon('note'))),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, diary.text),
          h('div', { className: 'bff-actions' },
            diary.kind === 'public' && diary.status === 'draft' && button('memoryPublishDraft', () => mutate('/diary/publish', { entityId: memory.entityId, id: diary.id }), { className: 'bff-sm', icon: 'check' }),
            preview(diary.id)))),
        !memory.items.length && !memory.diaries.length && h('div', { className: 'bff-empty' }, icon('memory'), h('p', null, t('memoryEmpty')))),
      forgetPreview && dialog(t('memoryForgetPreview'), [
        h('p', { key: 'count', className: 'bff-mono' }, `${t('memoryAffected')}: ${forgetPreview.expandedIds.length} · ${t('memorySources')}: ${forgetPreview.sourceObservationIds.length}`),
        h('p', { key: 'warning', className: 'bff-muted' }, t('memoryForgetWarning')), !data.world.paused && h('div', { key: 'pause' }, alert('warn', t('memoryPauseRequired')))], [
        button('discard', () => setForgetPreview(null), { className: 'bff-ghost', autoFocus: true, key: 'discard' }),
        button('memoryForgetConfirm', () => run(async () => {
          await request('/memory/forget', { entityId: forgetPreview.entityId, ids: forgetPreview.ids, expectedMemoryEpoch: forgetPreview.memoryEpoch, expectedRevision: forgetPreview.revision });
          setForgetPreview(null); await loadMemory(); await load(); setNotice(t('memoryCleanupPending'));
        }), { disabled: busy || !data.world.paused, className: 'bff-danger', icon: 'trash', key: 'confirm' })], () => setForgetPreview(null)));
  }
  function speechSettings() {
    const paused = data.world.paused, voices = runtimeInfo?.voices, unavailable = runtimeInfo && runtimeInfo.speech.status !== 'ready';
    const removeConfirmation = id => dialog(t('speechPanel.remove'), [h('p', { key: 'warning', className: 'bff-muted' }, t('speechPanel.removeWarning')), !paused && h('div', { key: 'pause' }, alert('warn', t('speechPanel.pauseRequired')))], [
      button('discard', () => setConfirmRemove(false), { className: 'bff-ghost', autoFocus: true, key: 'discard' }),
      button('speechPanel.removeConfirm', () => run(async () => { await request('/voice/reference/remove', { expectedRevision: runtimeInfo.speech.configurationRevision, ...(id === true ? {} : { voiceId: id }), confirmed: true }); clearAudio(); setConfirmRemove(false); await loadRuntime(); setNotice(t('speechPanel.removeSubmitted')); }), { disabled: busy || !paused, className: 'bff-danger', icon: 'trash', key: 'confirm' })], () => setConfirmRemove(false));
    const audition = id => run(async () => {
      const current = generation.current, value = await request('/voice/test', { voiceId: id });
      if (!mounted.current || generation.current !== current) return;
      const blob = voiceTestBlob(value); clearAudio(); const url = URL.createObjectURL(blob); audioObjectURL.current = url;
      setAudioTest({ url, model: value.model, durationMs: value.durationMs }); setNotice(t('speechPanel.testReady'));
    });
    const ttsReady = engine => runtimeInfo.speech.models['tts:' + engine]?.componentsPresent && runtimeInfo.speech.models['tts:' + engine]?.enabled;
    return h(React.Fragment, null,
      h('section', { className: 'bff-card' }, cardHead(h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile' }, icon('mic')), h('h2', null, t('speechPanel.title'))),
        button('speechPanel.refresh', () => run(loadRuntime), { className: 'bff-ghost bff-sm', icon: 'refresh' })),
        text('speechPanel.localHint'), !runtimeInfo ? text('speechPanel.pending') : unavailable ? alert('warn', t('speechPanel.unavailable.' + runtimeInfo.speech.status), { role: 'alert' }) : h(React.Fragment, null,
          h('div', { className: 'bff-table' }, h('table', null,
            h('thead', null, h('tr', null, ...['role', 'model', 'components', 'admission'].map(key => h('th', { key, scope: 'col' }, t('speechPanel.' + key))))),
            h('tbody', null, ...Object.entries(runtimeInfo.speech.models).map(([key, model]) => h('tr', { key },
              h('td', null, key.startsWith('tts:') ? t('speechPanel.tts') : t('speechPanel.' + key)), h('td', { className: 'bff-mono' }, model.model),
              h('td', null, badge(t(model.componentsPresent ? 'speechPanel.present' : 'speechPanel.missing'), model.componentsPresent ? 'ok' : 'danger')),
              h('td', null, badge(t(!model.enabled ? 'disabled' : model.verified ? 'speechPanel.benchmarkPassed' : 'speechPanel.notVerified'), !model.enabled ? '' : model.verified ? 'ok' : 'warn'))))))),
          text('speechPanel.benchmarkHint'),
          h('form', { onSubmit: event => { event.preventDefault(); if (!paused) return; void run(async () => {
            await request('/speech', speechPayload(runtimeInfo.speech.configurationRevision, speechDraft)); await loadRuntime(); setNotice(t('saved'));
          }); } },
            h('div', { className: 'bff-form-grid' },
              ...[['numThreads', 1, 16], ['maxTextChars', 1, 120]].map(([key, min, max]) => h('label', { key }, h('span', null, t('speechPanel.' + key)), h('input', { type: 'number', min, max, step: 1, required: true, value: speechDraft[key], disabled: busy || !paused, onChange: e => setSpeechDraft({ ...speechDraft, [key]: e.target.value }) })))),
            !paused && alert('warn', t('speechPanel.pauseRequired')),
            h('button', { type: 'submit', disabled: busy || !paused }, icon('save'), t('speechPanel.save'))))),
      runtimeInfo && !unavailable && h('section', { className: 'bff-card' }, cardHead(h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile' }, icon('volume')), h('h2', null, t('speechPanel.voiceTitle')))),
        text('speechPanel.voiceHint'), text('speechPanel.conditioningHint'),
        !voices.profiles.length ? h('div', { role: 'status', className: 'bff-empty' }, icon('volume'), h('p', null, t('speechPanel.noVoices'))) : h('div', { className: 'bff-table' }, h('table', null,
          h('thead', null, h('tr', null, ...['voiceLabel', 'voiceLanguage', 'voiceScope', 'voiceReference', 'voiceActions'].map(key => h('th', { key, scope: 'col' }, t('speechPanel.' + key))))),
          h('tbody', null, ...voices.profiles.map(p => h('tr', { key: p.id },
            h('td', null, h('div', { className: 'bff-actions' }, h('strong', null, p.label), h('code', { className: 'bff-subtle' }, p.id), voices.defaultVoice === p.id ? badge(t('speechPanel.isDefault'), 'primary', icon('star')) : null)),
            h('td', { className: 'bff-mono' }, p.referenceLanguage), h('td', null, badge(t('speechPanel.scope.' + p.usageScope))),
            h('td', null, badge(t(p.hasReference ? 'speechPanel.referenceOk' : 'speechPanel.referenceMissing'), p.hasReference ? 'ok' : 'danger')),
            h('td', null, h('div', { className: 'bff-actions' },
              voices.defaultVoice !== p.id && button('speechPanel.makeDefault', () => run(async () => { await request('/voice/default', { expectedRevision: runtimeInfo.speech.configurationRevision, voiceId: p.id }); await loadRuntime(); setNotice(t('saved')); }), { disabled: busy || !paused, className: 'bff-ghost bff-sm', icon: 'star' }),
              button('speechPanel.test', () => audition(p.id), { disabled: busy || !paused || !p.hasReference || !ttsReady(p.engine), className: 'bff-ghost bff-sm', icon: 'volume' }),
              button('speechPanel.remove', () => setConfirmRemove(p.id), { disabled: busy || !paused || voices.cleanupPending, className: 'bff-danger-ghost bff-sm', icon: 'trash' })))))))),
        voices.defaultVoice === null && voices.profiles.length > 0 && alert('info', t('speechPanel.noDefault')),
        voices.cleanupPending && h(React.Fragment, null, alert('warn', t('speechPanel.cleanupPending')),
          h('div', { className: 'bff-actions' }, button('speechPanel.retryCleanup', () => setConfirmRemove(true), { disabled: busy || !paused, icon: 'refresh' }))),
        audioTest && h('div', { className: 'bff-audio' }, h('p', { className: 'bff-small bff-muted' }, `${audioTest.model} · ${(audioTest.durationMs / 1000).toFixed(1)} ${t('speechPanel.seconds')}`), h('audio', { controls: true, preload: 'none', src: audioTest.url, 'aria-label': t('speechPanel.testAudio') })),
        text('speechPanel.testHint'),
        !voices.cleanupPending && h(React.Fragment, null, h('hr'), h('h3', null, t('speechPanel.addVoice')), h('form', { onSubmit: event => {
          event.preventDefault(); if (!paused) return; void run(async () => {
            const file = referenceFileInput.current?.files?.[0], transcript = referenceTranscriptInput.current?.value || '', authorized = referenceConsentInput.current?.checked === true;
            try {
              if (!authorized) throw Object.assign(new Error('reference_authorization_required'), { code: 'reference_authorization_required' });
              const audioBase64 = await readReferenceFile(file), payload = referencePayload(runtimeInfo.speech.configurationRevision, audioBase64, transcript, authorized, voiceDraft);
              clearReferenceInputs(); await request('/voice/reference', payload); clearAudio(); setVoiceDraft(VOICE_DRAFT); await loadRuntime(); setNotice(t('speechPanel.referenceSaved'));
            } finally { clearReferenceInputs(); }
          });
        } },
          h('div', { className: 'bff-form-grid' },
            ...[['voiceId', 40], ['label', 64], ['language', 3]].map(([key, maxLength]) => h('label', { key }, h('span', null, t('speechPanel.voiceField.' + key)), h('input', { value: voiceDraft[key], required: true, maxLength, disabled: busy || !paused, autoComplete: 'off', spellCheck: false, onChange: e => setVoiceDraft({ ...voiceDraft, [key]: e.target.value }) }))),
            h('label', null, h('span', null, t('speechPanel.voiceField.usageScope')), h('select', { value: voiceDraft.usageScope, disabled: busy || !paused, onChange: e => setVoiceDraft({ ...voiceDraft, usageScope: e.target.value }) }, ...['private', 'public'].map(scope => h('option', { key: scope, value: scope }, t('speechPanel.scope.' + scope)))))),
          h('label', null, h('span', null, t('speechPanel.audioFile')), h('input', { ref: referenceFileInput, type: 'file', accept: '.wav,audio/wav', required: true, disabled: busy || !paused })),
          h('label', null, h('span', null, t('speechPanel.transcript')), h('textarea', { ref: referenceTranscriptInput, required: true, maxLength: 1000, disabled: busy || !paused, autoComplete: 'off', spellCheck: false })),
          h('label', { className: 'bff-check' }, h('input', { ref: referenceConsentInput, type: 'checkbox', required: true, disabled: busy || !paused }), h('span', null, t('speechPanel.authorized'))),
          !paused && alert('warn', t('speechPanel.pauseRequired')),
          h('button', { type: 'submit', disabled: busy || !paused }, icon('upload'), t('speechPanel.upload')))),
        confirmRemove !== false && removeConfirmation(confirmRemove)),
      h('section', { className: 'bff-card' }, cardHead(h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile' }, icon('image')), h('h2', null, t('speechPanel.imageTitle')))), text(runtimeInfo ? 'speechPanel.imageUnavailable' : 'speechPanel.pending')));
  }
  function runtime() {
    return h(React.Fragment, null,
      standalone ? h('section', { className: 'bff-card' }, h('h2', null, t('runtime')), text('standaloneRuntimeHint')) : h(React.Fragment, null, ...[['runtime', 'runtimeHint'], ['strategy', 'strategyHint']].map(([title, hint]) => h('section', { key: title, className: 'bff-card' }, h('h2', null, t(title)), text(hint)))),
      standalone && speechSettings(), modelSettings(),
      h('section', { className: 'bff-card' }, h('h2', null, t('setup')), text(standalone ? 'standaloneSetupHint' : 'setupHint')));
  }
  function skeleton() {
    const block = (height, width = '100%') => h('div', { className: 'bff-skeleton', style: { height, width } });
    return h('div', { className: 'bff-page' }, h('p', { className: 'bff-sr-only' }, t('loading')),
      h('div', { className: 'bff-stack-sm', 'aria-hidden': true }, block(22, 180), block(14, 'min(420px,80%)')),
      h('div', { className: 'bff-grid', 'aria-hidden': true }, block(84), block(84), block(84), block(84)),
      h('div', { 'aria-hidden': true }, block(160)), h('div', { 'aria-hidden': true }, block(120)));
  }
  // Command palette (cmd/ctrl-K): navigation plus the same actions the visible controls offer.
  const commands = !token || !data ? [] : [
    ...NAV.map(item => ({ id: 'go-' + item.id, group: 'shell.pages', label: t(item.id), icon: item.icon, keys: ['G', item.key], disabled: busy, run: () => go(item.id) })),
    { id: 'refresh', group: 'shell.actions', label: t('refresh'), icon: 'refresh', disabled: busy, run: refreshAll },
    { id: 'theme', group: 'shell.actions', label: t(effectiveTheme === 'dark' ? 'shell.themeLight' : 'shell.themeDark'), icon: effectiveTheme === 'dark' ? 'sun' : 'moon', run: toggleTheme },
    { id: 'system', group: 'shell.actions', label: t('shell.themeSystem'), icon: 'monitor', run: () => setTheme('system') },
    { id: 'logout', group: 'shell.actions', label: t('logout'), icon: 'logout', run: forget },
  ];
  const query = (palette?.query || '').trim().toLowerCase();
  const matches = commands.filter(command => !query || command.label.toLowerCase().includes(query) || command.id.includes(query));
  const selected = palette ? Math.min(palette.index, Math.max(0, matches.length - 1)) : 0;
  function execute(command) { if (!command || command.disabled) return; setPalette(null); command.run(); }
  function commandPalette() {
    let lastGroup = '';
    return h('div', { className: 'bff-overlay', onClick: event => { if (event.target === event.currentTarget) setPalette(null); } },
      h('div', { className: 'bff-palette', role: 'dialog', 'aria-modal': true, 'aria-label': t('shell.palette') },
        h('div', { className: 'bff-palette-in' }, icon('search'),
          h('input', { autoFocus: true, value: palette.query, placeholder: t('shell.paletteSearch'), 'aria-label': t('shell.paletteSearch'), role: 'combobox', 'aria-expanded': true, 'aria-controls': 'bff-palette-list', 'aria-activedescendant': matches[selected] ? 'bff-cmd-' + matches[selected].id : undefined, autoComplete: 'off', spellCheck: false,
            onChange: event => setPalette({ query: event.target.value, index: 0 }),
            onKeyDown: event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1; setPalette({ ...palette, index: matches.length ? (selected + step + matches.length) % matches.length : 0 }); }
              else if (event.key === 'Enter') { event.preventDefault(); execute(matches[selected]); }
            } }), kbd('Esc')),
        h('div', { className: 'bff-palette-list', id: 'bff-palette-list', role: 'listbox' },
          matches.length ? matches.flatMap((command, index) => {
            const heading = command.group !== lastGroup ? h('div', { key: 'group-' + command.group, className: 'bff-side-section', role: 'presentation' }, t(command.group)) : null;
            lastGroup = command.group;
            return [heading, h('button', { key: command.id, id: 'bff-cmd-' + command.id, type: 'button', role: 'option', className: 'bff-palette-item', 'aria-selected': index === selected, disabled: command.disabled, tabIndex: -1,
              onMouseEnter: () => setPalette({ ...palette, index }), onClick: () => execute(command) }, icon(command.icon), command.label, command.keys ? h('span', { className: 'bff-row', style: { marginLeft: 'auto', gap: '2px' } }, ...command.keys.map(kbd)) : null)];
          }) : h('p', { className: 'bff-palette-empty' }, t('shell.paletteEmpty'))),
        h('div', { className: 'bff-palette-foot' }, h('span', null, kbd('↑'), ' ', kbd('↓'), ' ', t('shell.paletteSelect')), h('span', null, kbd('↵'), ' ', t('shell.paletteRun')), h('span', null, t('shell.paletteGo')))));
  }
  keyHandler.current = event => {
    if (!token || !data) return;
    const key = event.key || '';
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'k') { event.preventDefault(); setPalette(palette ? null : { query: '', index: 0 }); return; }
    if (key === 'Escape') {
      if (palette) setPalette(null);
      else if (forgetPreview && !busy) setForgetPreview(null);
      else if (confirmRemove !== false && !busy) setConfirmRemove(false);
      else if (drawer) setDrawer(false);
      return;
    }
    const target = event.target || {};
    if (palette || forgetPreview || confirmRemove !== false || event.metaKey || event.ctrlKey || event.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
    if (key.toLowerCase() === 'g') { gPressedAt.current = Date.now(); return; }
    if (Date.now() - gPressedAt.current < 1200) {
      gPressedAt.current = 0;
      const item = NAV.find(entry => entry.key === key.toUpperCase());
      if (item && !busy) { event.preventDefault(); go(item.id); }
    }
  };
  const noticeWarn = ['modelTestFailed', 'memoryCleanupPending'].some(key => notice === t(key));
  const toasts = h('div', { className: 'bff-toasts', 'aria-live': 'polite' }, notice ? h('div', { className: 'bff-toast', role: 'status', key: notice },
    h('span', { style: noticeWarn ? { color: 'var(--bff-warn)', display: 'flex' } : { display: 'flex' } }, icon(noticeWarn ? 'alert' : 'check')), h('p', null, notice),
    h('button', { type: 'button', className: 'bff-icon-btn', 'aria-label': t('shell.dismiss'), onClick: () => setNotice('') }, icon('x'))) : null);
  const busyLive = h('div', { role: 'status', 'aria-live': 'polite', className: 'bff-sr-only' }, busy ? t('busy') : '');
  const errorAlert = error ? alert('danger', error, { role: 'alert' }) : null;
  const themeButton = h('button', { type: 'button', className: 'bff-icon-btn', onClick: toggleTheme, 'aria-label': t(effectiveTheme === 'dark' ? 'shell.themeLight' : 'shell.themeDark'), title: t(effectiveTheme === 'dark' ? 'shell.themeLight' : 'shell.themeDark') }, icon(effectiveTheme === 'dark' ? 'sun' : 'moon'));
  if (!token) {
    return h('div', { className: 'bff-world bff-auth-wrap', 'aria-busy': busy },
      h('main', { className: 'bff-card bff-auth' },
        h('div', { className: 'bff-spread' }, h('div', { className: 'bff-row' }, h('span', { className: 'bff-tile bff-logo' }, icon('fish')), h('h1', null, t('title'))), themeButton),
        text(standalone ? 'standaloneDescription' : 'description'), errorAlert,
        h('h2', null, t('authorization')), text('authHint'),
        h('form', { onSubmit: event => { event.preventDefault(); if (!input.trim() || busy) return; const credential = input.trim();
          try { sessionStorage.setItem(TOKEN_KEY, credential); } catch {} setToken(credential); setInput('');
        } }, h('label', null, h('span', null, t('token')), h('input', { type: 'password', value: input, onChange: event => setInput(event.target.value), autoComplete: 'off', spellCheck: false, disabled: busy })),
        h('button', { type: 'submit', disabled: busy || !input.trim() }, icon('lock'), t('login')))),
      busyLive, toasts);
  }
  const tabLoading = busy && ((tab === 'channels' && !qq) || (standalone && tab === 'runtime' && !runtimeInfo));
  const current = NAV.find(item => item.id === tab) || NAV[0];
  return h('div', { className: `bff-world bff-app${drawer ? ' bff-drawer-open' : ''}`, 'aria-busy': busy },
    h('aside', { className: 'bff-side', 'aria-label': t('title') },
      h('div', { className: 'bff-brand' }, h('span', { className: 'bff-tile bff-logo' }, icon('fish')),
        h('div', { className: 'bff-grow' }, h('div', { className: 'bff-brand-name' }, t('title')), h('div', { className: 'bff-brand-sub' }, t('shell.subtitle'))),
        h('button', { type: 'button', className: 'bff-icon-btn bff-mobile-only', 'aria-label': t('shell.closeMenu'), onClick: () => setDrawer(false) }, icon('x'))),
      data && h('button', { type: 'button', className: 'bff-search', onClick: () => setPalette({ query: '', index: 0 }) }, icon('search'), h('span', { className: 'bff-grow' }, t('shell.search')), kbd(MOD), kbd('K')),
      data && h('div', { className: 'bff-side-section' }, t('shell.section')),
      data && h('nav', { 'aria-label': t('title') }, ...NAV.map(item => h('button', { key: item.id, type: 'button', className: 'bff-nav', disabled: busy, 'aria-current': tab === item.id ? 'page' : undefined, onClick: () => go(item.id) },
        icon(item.icon), t(item.id),
        item.id === 'overview' && data.counts.pending > 0 ? h('span', { className: 'bff-nav-count' }, String(data.counts.pending)) : null,
        h('span', { className: 'bff-nav-hint', 'aria-hidden': true }, kbd('G'), kbd(item.key))))),
      h('div', { className: 'bff-side-foot' },
        data && h('div', { className: 'bff-side-card' },
          h('div', { className: 'bff-row' }, h('span', { className: 'bff-small bff-muted' }, t('shell.worldStatus')), worldBadge()),
          h('div', { className: 'bff-row' }, h('span', { className: 'bff-small bff-muted' }, t('revision')), h('span', { className: 'bff-mono' }, String(data.world.revision)))),
        h('div', { className: 'bff-spread' }, h('span', { className: 'bff-op' }, icon('shield'), t('shell.authorized')), themeButton),
        button('logout', forget, { className: 'bff-ghost bff-sm', icon: 'logout' }))),
    h('div', { className: 'bff-scrim', onClick: () => setDrawer(false), 'aria-hidden': true }),
    h('div', { className: 'bff-main' },
      h('header', { className: 'bff-topbar' },
        h('button', { type: 'button', className: 'bff-icon-btn bff-mobile-only', 'aria-label': t('shell.menu'), 'aria-expanded': drawer, onClick: () => setDrawer(true) }, icon('menu')),
        h('div', { className: 'bff-crumb' }, h('span', { className: 'bff-muted bff-hide-sm' }, t('title')), h('span', { className: 'bff-hide-sm' }, icon('chevron')), h('strong', null, t(current.id))),
        h('div', { className: 'bff-grow' }),
        data && h('span', { className: 'bff-hide-sm' }, worldBadge()),
        button('refresh', refreshAll, { className: 'bff-ghost bff-sm', icon: 'refresh' }),
        data && h('button', { type: 'button', className: 'bff-icon-btn', 'aria-label': `${t('shell.palette')} (${MOD}K)`, title: `${t('shell.palette')} ${MOD}K`, onClick: () => setPalette({ query: '', index: 0 }) }, icon('command')),
        busy && h('div', { className: 'bff-busybar', 'aria-hidden': true })),
      h('main', { className: 'bff-content' }, errorAlert,
        !data ? (busy ? skeleton() : h('div', { className: 'bff-empty' }, icon('alert'), h('p', null, t('error'))))
          : tabLoading ? skeleton()
          : h('section', { className: 'bff-page', key: tab, 'aria-labelledby': 'bff-page-title' },
            h('div', { className: 'bff-page-head' }, h('div', null, h('h1', { id: 'bff-page-title' }, t(current.id)), tab === 'overview' && h('p', null, t(standalone ? 'standaloneDescription' : 'description')))),
            tab === 'overview' ? overview() : tab === 'persona' ? persona() : tab === 'channels' ? channels() : tab === 'memory' ? memories() : runtime()))),
    palette && commandPalette(), busyLive, toasts);
}
export function flattenDictionary(dictionary, prefix = '') {
  return Object.fromEntries(Object.entries(dictionary).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : Object.entries(flattenDictionary(value, path));
  }));
}
