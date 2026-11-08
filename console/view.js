// Shared UI for the standalone browser entry.
import React from 'react';
import DICTIONARIES from './dictionaries.js';
import { TOKEN_KEY, operatorRequest, personaDraft, personaPatch, personaExport, personaImport, validWorld, validQQ, qqPayload, modelPayload } from './operator-client.js';
import { validRuntime, speechPayload, readReferenceFile, referencePayload, voiceTestBlob } from './runtime-client.js';
const h = React.createElement;
const { useState, useRef, useEffect } = React;
const NS = 'companion.world';
const VOICE_DRAFT = { voiceId: '', label: '', language: 'ja', usageScope: 'private' };
const CSS = `
.bff-world .bff-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.bff-world select{display:block;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,var(--bff-field,#fff));border:1px solid var(--dsw-alias-border-l2,var(--bff-border,#cbd5e1));border-radius:8px;padding:8px 10px}.bff-world .bff-check{display:flex;gap:10px;align-items:flex-start}.bff-world .bff-check input{width:18px;height:18px;flex:none;margin-top:4px}.bff-world .bff-check span{margin:0}.bff-world input[type=file]{overflow:hidden}.bff-world audio{width:100%;max-width:520px}.bff-world hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,var(--bff-border,#cbd5e1));margin:20px 0}.bff-world .bff-audio{margin-top:16px}
.bff-world{color:var(--dsw-alias-label-primary, var(--bff-text, #19263b));font:inherit;font-size:14px;line-height:1.6;max-width:960px;padding:20px 24px 40px;box-sizing:border-box}
.bff-world *{box-sizing:border-box}.bff-world h1{font-size:22px;margin:0}.bff-world h2{font-size:16px;margin:0 0 12px}.bff-world p{margin:8px 0 16px}.bff-world .bff-muted{opacity:.72}
.bff-world .bff-head,.bff-world .bff-actions,.bff-world nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bff-world .bff-head{justify-content:space-between}.bff-world nav{margin:20px 0;border-bottom:1px solid var(--dsw-alias-border-l2, var(--bff-border, #cbd5e1));padding-bottom:12px}
.bff-world button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2, var(--bff-border, #cbd5e1));border-radius:8px;min-height:36px;padding:6px 14px;cursor:pointer}.bff-world button:hover:not(:disabled),.bff-world button[aria-current=page]{background:var(--dsw-alias-bg-layer-2, var(--bff-hover, #e8f0f8))}.bff-world button:disabled{opacity:.45;cursor:default}
.bff-world input,.bff-world textarea{display:block;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1, var(--bff-field, #ffffff));border:1px solid var(--dsw-alias-border-l2, var(--bff-border, #cbd5e1));border-radius:8px;padding:8px 10px}.bff-world textarea{resize:vertical;min-height:88px}.bff-world label{display:block;margin:0 0 16px}.bff-world label>span{display:block;margin-bottom:6px}.bff-world :focus-visible{outline:2px solid currentColor;outline-offset:3px}
.bff-world .bff-card{border:1px solid var(--dsw-alias-border-l2, var(--bff-border, #cbd5e1));border-radius:12px;padding:16px;margin:16px 0}.bff-world .bff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.bff-world dl{margin:0}.bff-world dd{margin:4px 0 0;font-size:20px;font-variant-numeric:tabular-nums}.bff-world .bff-time{font-size:14px;overflow-wrap:anywhere}.bff-world .bff-table{overflow:auto}.bff-world table{border-collapse:collapse;width:100%;text-align:left}.bff-world th,.bff-world td{border-bottom:1px solid var(--dsw-alias-border-l2, var(--bff-border, #cbd5e1));padding:10px 12px 10px 0;vertical-align:top;overflow-wrap:anywhere}.bff-world code{user-select:all;overflow-wrap:anywhere}.bff-world .bff-status{font-size:18px;font-weight:600}.bff-world [role=alert]{border-left:3px solid currentColor;padding:8px 12px}.bff-world .bff-auth{max-width:560px}@media(max-width:600px){.bff-world{padding:16px 12px}.bff-world .bff-head{align-items:flex-start}}
`;
function Fish() {
  return h('svg', { viewBox: '0 0 64 64', width: 36, height: 36, 'aria-hidden': true },
    h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 16, fill: '#0e7490' }),
    h('path', { d: 'M17 33c5-8 12-12 20-12 6 0 10 3 12 6-3 5-8 8-15 8-5 0-9-1-12-4l-5 6zM42 27l11-7-2 9 2 9-11-6z', fill: '#f8fafc' }),
    h('circle', { cx: 35, cy: 29, r: 2.4, fill: '#0f172a' }));
}
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
  const button = (key, onClick, extra = {}) => h('button', { type: 'button', disabled: busy, onClick, ...extra }, t(key));
  const text = key => h('p', { className: 'bff-muted' }, t(key));
  function field(key, multiline = false) {
    return h('label', { key }, h('span', null, t(key)), h(multiline ? 'textarea' : 'input', {
      name: key, value: draft[key], disabled: busy, onChange: event => setDraft({ ...draft, [key]: event.target.value }),
    }));
  }
  function time(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function overview() {
    return h(React.Fragment, null,
      h('section', { className: 'bff-card' }, h('div', { className: 'bff-head' }, h('span', { className: 'bff-status' }, t(data.world.paused ? 'paused' : 'running')),
        button(data.world.paused ? 'resume' : 'pause', () => run(async () => {
          await request('/world/pause', { paused: !data.world.paused }); await load(); setNotice(t('saved'));
        }))), text('pauseHint')),
      h('div', { className: 'bff-grid' }, ...['worldTime', 'realTime', 'revision'].map((key, index) => h('dl', { key, className: 'bff-card' },
        h('dt', null, t(key)), h('dd', { className: index < 2 ? 'bff-time' : '' }, index === 0 ? time(data.world.worldNow) : index === 1 ? time(data.world.realNow) : data.world.revision)))),
      h('div', { className: 'bff-grid' }, ...['facts', 'notes', 'experiences', 'pending'].map(key => h('dl', { key, className: 'bff-card' }, h('dt', null, t(key)), h('dd', null, data.counts[key])))), text('snapshot'));
  }
  function persona() {
    return h('form', { onSubmit: event => { event.preventDefault(); void run(async () => {
      await request('/persona', { patch: personaPatch(draft) }); await load(); setNotice(t('saved'));
    }); } }, h('h2', null, `${t('personaRevision')}: ${data.persona.revision}`), text('arrayHint'),
    ...['name', 'userCallName', 'relationshipStage', 'identity', 'traits', 'speechStyle', 'boundaries', 'principles'].map(key => field(key, !['name', 'userCallName', 'relationshipStage'].includes(key))),
    text('personaPanel.neutralHint'), personaExamples(), personaPreviewCard(), personaFiles(),
    h('div', { className: 'bff-actions' }, h('button', { type: 'submit', disabled: busy }, t('save')), button('discard', () => setDraft(personaDraft(data.persona.value)))), text('conflictHint'));
  }
  function personaExamples() {
    const examples = draft.examples;
    const change = next => setDraft({ ...draft, examples: next });
    const move = (from, to) => { const next = [...examples]; next.splice(to, 0, next.splice(from, 1)[0]); change(next); };
    return h('fieldset', { className: 'bff-card' }, h('legend', null, t('personaPanel.examples')),
      examples.length ? null : text('personaPanel.noExamples'),
      ...examples.map((entry, index) => h('div', { key: index, className: 'bff-card' },
        ...['user', 'assistant'].map(side => h('label', { key: side }, h('span', null, `${index + 1}. ${t(side === 'user' ? 'personaPanel.exampleUser' : 'personaPanel.exampleAssistant')}`),
          h('textarea', { name: `example-${index}-${side}`, value: entry[side], disabled: busy, onChange: event => change(examples.map((item, i) => i === index ? { ...item, [side]: event.target.value } : item)) }))),
        h('div', { className: 'bff-actions' },
          button('personaPanel.moveUp', () => move(index, index - 1), { disabled: busy || index === 0 }),
          button('personaPanel.moveDown', () => move(index, index + 1), { disabled: busy || index === examples.length - 1 }),
          button('personaPanel.removeExample', () => change(examples.filter((_, i) => i !== index)))))),
      h('div', { className: 'bff-actions' }, button('personaPanel.addExample', () => change([...examples, { user: '', assistant: '' }]))));
  }
  function personaPreviewCard() {
    const source = JSON.stringify(personaPatch(draft));
    const current = personaPreview?.source === source ? personaPreview : null;
    return h('section', { className: 'bff-card' }, h('h2', null, t('personaPanel.previewTitle')), text('personaPanel.previewHint'),
      h('div', { className: 'bff-actions' }, button('personaPanel.preview', () => run(async () => {
        const value = await request('/persona/preview', { patch: JSON.parse(source) });
        setPersonaPreview({ source, text: value.text, chars: value.chars, limit: value.limit });
      }))),
      current && h(React.Fragment, null,
        h('p', null, `${t('personaPanel.previewCount')}: ${current.chars} / ${current.limit}`),
        h('p', current.chars > current.limit ? { role: 'alert' } : { className: 'bff-muted' }, t(current.chars > current.limit ? 'personaPanel.previewTruncated' : 'personaPanel.previewFits')),
        h('textarea', { readOnly: true, value: current.text, rows: 16, 'aria-label': t('personaPanel.previewTitle') })));
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
        button('personaPanel.export', exportJSON),
        h('label', null, h('span', null, t('personaPanel.import')), h('input', { type: 'file', accept: 'application/json,.json', disabled: busy, onChange: event => { void importJSON(event); } })),
        data.persona.default && button('personaPanel.loadDefault', () => { setDraft(personaDraft(data.persona.default)); setNotice(t('personaPanel.defaultLoaded')); })));
  }
  function qqSettings() {
    return h('section', { className: 'bff-card' }, h('h2', null, t('qqTitle')), text('qqPrivateHint'),
      button('qqRefresh', () => run(async () => { await loadQQ(); await load(); })),
      !qq ? text('qqStatusPending') : h(React.Fragment, null,
        h('p', { role: 'status' }, `${t(qq.loggedIn ? 'qqLoggedIn' : 'qqWaitingLogin')} · ${t(qq.connected ? 'qqConnected' : 'qqDisconnected')}`),
        text(qq.configured ? 'qqConfigured' : 'qqNotConfigured'), text(qq.callerConfigured ? 'qqCallerConfigured' : 'qqCallerMissing'),
        text(qq.paused ? 'qqPaused' : 'qqRunning'),
        !qq.loggedIn && text('qqLoginHint'),
        (!data.world.paused || !qq.paused) && text('qqPauseRequired'),
        h('form', { onSubmit: event => { event.preventDefault(); if (!qq.loggedIn || !qq.paused || !data.world.paused) return; void run(async () => {
          await request('/qq', qqPayload(qqCallerInput.current?.value || ''));
          if (qqCallerInput.current) qqCallerInput.current.value = '';
          await loadQQ(); await load(); setNotice(t('saved'));
        }); } },
        h('label', null, h('span', null, t('qqCallerUID')), h('input', { ref: qqCallerInput, type: 'text', inputMode: 'numeric', pattern: '[0-9]+', required: true, disabled: busy || !qq.loggedIn || !qq.paused || !data.world.paused, autoComplete: 'off', spellCheck: false })),
        text('qqCallerHint'), text('qqCallerPrivacy'),
        h('button', { type: 'submit', disabled: busy || !qq.loggedIn || !qq.paused || !data.world.paused }, t('qqSave')))));
  }
  function channels() {
    return h(React.Fragment, null,
      ...data.channels.map(channel => h('section', { className: 'bff-card', key: channel.id },
        h('h2', null, channel.name || channel.id), h('code', null, channel.id),
        h('p', null, `${t(channel.id === 'qq' && ['not_configured', 'waiting_login', 'ready', 'disconnected', 'error'].includes(channel.status) ? `qqChannelStatus.${channel.status}` : channel.status === 'available' ? 'available' : channel.status === 'not_configured' ? 'not_configured' : 'unknown')} · ${t(channel.enabled ? 'enabled' : 'disabled')} · ${t('boundStreams')}: ${channel.boundStreams}`))),
      !data.channels.length && text('noChannels'), qqSettings(),
      h('h2', null, t('channels')), data.bindings.length ? h('div', { className: 'bff-table' }, h('table', null,
        h('thead', null, h('tr', null, ...['source', 'conversation', 'person', 'audience'].map(key => h('th', { key, scope: 'col' }, t(key))))),
        h('tbody', null, ...data.bindings.map((binding, index) => h('tr', { key: binding.sourceId === 'qq' ? `qq:${index}` : `${binding.sourceId}:${binding.conversationId}:${index}` },
          ...['sourceId', 'conversationId', 'personId', 'audience'].map(key => h('td', { key }, binding.sourceId === 'qq' && key === 'conversationId' ? t('qqPrivateConversation') : String(binding[key] ?? '—')))))))) : text('noBindings'));
  }
  function modelSettings() {
    const model = data.model;
    return h('section', { className: 'bff-card' }, h('h2', null, t('model')),
      h('p', { role: 'status' }, t(`modelStatus.${model.status}`)), text('modelHint'),
      model.lastTest && h('p', null, `${t('modelLastTest')}: ${time(model.lastTest.at)} · ${t(model.lastTest.ok ? 'modelTestPassed' : 'modelTestFailed')}`),
      h('form', { onSubmit: event => { event.preventDefault(); if (!data.world.paused || !['deepseek-flash', 'deepseek-v4-pro'].includes(modelName.trim())) return; void run(async () => {
        const payload = modelPayload(modelName, apiKeyInput.current?.value || '');
        if (apiKeyInput.current) apiKeyInput.current.value = '';
        await request('/model', payload);
        await load(); setNotice(t('saved'));
      }); } },
      h('label', null, h('span', null, t('modelName')), h('input', { value: modelName, disabled: busy, required: true, pattern: 'deepseek-(flash|v4-pro)', autoComplete: 'off', spellCheck: false,
        onChange: event => setModelName(event.target.value) })),
      h('label', null, h('span', null, t('modelApiKey')), h('input', { ref: apiKeyInput, type: 'password', disabled: busy, autoComplete: 'off', spellCheck: false, autoCapitalize: 'none' })),
      text(model.configured ? 'modelKeyKeep' : 'modelKeyRequired'), text('modelKeyPrivacy'),
      !data.world.paused && text('modelPauseRequired'),
      h('button', { type: 'submit', disabled: busy || !data.world.paused || !['deepseek-flash', 'deepseek-v4-pro'].includes(modelName.trim()) }, t('modelSave'))),
      text('modelTestHint'),
      button('modelTest', () => run(async () => {
        const result = await request('/model/test', {});
        if (typeof result?.ok !== 'boolean' || typeof result.model !== 'string') throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
        await load(); setNotice(t(result.ok ? 'modelTestPassed' : 'modelTestFailed'));
      }), { disabled: busy || !model.configured }));
  }
  async function loadMemory() {
    const value = await request('/memory');
    if (!value || typeof value.entityId !== 'string' || !Array.isArray(value.items) || !Array.isArray(value.diaries)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    setMemory(value);
  }
  function memories() {
    const mutate = (path, payload) => run(async () => { await request(path, payload); await loadMemory(); setNotice(t('saved')); });
    return h('section', { className: 'bff-card' }, h('h2', null, t('memoryTitle')), text('memoryPrivacy'), text('memoryLifecycle'),
      button('memoryReadExplicitly', () => run(loadMemory)),
      button('memoryCleanupRefresh', () => run(async () => { const jobs = await request('/memory/cleanup/pending'); setNotice(t(jobs.length ? 'memoryCleanupPending' : 'memoryCleanupComplete')); })), 
      memory && h(React.Fragment, null,
        h('p', null, `${t('memoryEntity')}: ${memory.entityId}`),
        ...memory.items.map(item => h('article', { className: 'bff-card', key: item.id },
          h('strong', null, `${item.type} · ${item.status}`),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, item.summary || item.text || `${item.key || ''}: ${item.value || ''}`),
          h('form', { onSubmit: event => { event.preventDefault(); const value = event.currentTarget.elements.eventAt.value; const eventAt = value ? Date.parse(value) : null; if (eventAt !== null && !Number.isFinite(eventAt)) return; void mutate('/memory/retention', { entityId: memory.entityId, id: item.id, eventAt }); } },
            h('label', null, h('span', null, t('memoryEventTime')), h('input', { name: 'eventAt', type: 'datetime-local', disabled: busy, defaultValue: item.eventAt == null ? '' : new Date(item.eventAt - new Date(item.eventAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) })),
            button('memorySaveEventTime', undefined, { type: 'submit' })),
          h('div', { className: 'bff-actions' },
            button(item.pinned ? 'memoryUnpin' : 'memoryPin', () => mutate('/memory/retention', { entityId: memory.entityId, id: item.id, pinned: !item.pinned })),
            item.visibility !== 'public' && item.kind !== 'inner' && button('memoryPublicAuthorize', () => mutate('/memory/public', { entityId: memory.entityId, id: item.id })),
            button('memoryForgetPreview', () => run(async () => { setForgetPreview(await request('/memory/forget-preview', { entityId: memory.entityId, ids: [item.id] })); }))))),
        ...memory.diaries.map(diary => h('article', { className: 'bff-card', key: diary.id },
          h('strong', null, t(diary.kind === 'private' ? 'memoryPrivateDiary' : diary.status === 'published' ? 'memoryPublishedDiary' : 'memoryPublicDraft')),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, diary.text),
          diary.kind === 'public' && diary.status === 'draft' && button('memoryPublishDraft', () => mutate('/diary/publish', { entityId: memory.entityId, id: diary.id })),
          button('memoryForgetPreview', () => run(async () => { setForgetPreview(await request('/memory/forget-preview', { entityId: memory.entityId, ids: [diary.id] })); })))),
        !memory.items.length && !memory.diaries.length && text('memoryEmpty')),
      forgetPreview && h('section', { className: 'bff-card' }, h('h3', null, t('memoryForgetPreview')),
        h('p', null, `${t('memoryAffected')}: ${forgetPreview.expandedIds.length} · ${t('memorySources')}: ${forgetPreview.sourceObservationIds.length}`),
        text('memoryForgetWarning'), !data.world.paused && text('memoryPauseRequired'),
        button('memoryForgetConfirm', () => run(async () => {
          await request('/memory/forget', { entityId: forgetPreview.entityId, ids: forgetPreview.ids, expectedMemoryEpoch: forgetPreview.memoryEpoch, expectedRevision: forgetPreview.revision });
          setForgetPreview(null); await loadMemory(); await load(); setNotice(t('memoryCleanupPending'));
        }), { disabled: busy || !data.world.paused }), button('discard', () => setForgetPreview(null))));
  }
  function speechSettings() {
    const paused = data.world.paused, voices = runtimeInfo?.voices, unavailable = runtimeInfo && runtimeInfo.speech.status !== 'ready';
    const removeConfirmation = id => h('div', { role: 'alertdialog', 'aria-label': t('speechPanel.remove') }, text('speechPanel.removeWarning'),
      button('speechPanel.removeConfirm', () => run(async () => { await request('/voice/reference/remove', { expectedRevision: runtimeInfo.speech.configurationRevision, ...(id === true ? {} : { voiceId: id }), confirmed: true }); clearAudio(); setConfirmRemove(false); await loadRuntime(); setNotice(t('speechPanel.removeSubmitted')); }), { disabled: busy || !paused }), button('discard', () => setConfirmRemove(false)));
    const audition = id => run(async () => {
      const current = generation.current, value = await request('/voice/test', { voiceId: id });
      if (!mounted.current || generation.current !== current) return;
      const blob = voiceTestBlob(value); clearAudio(); const url = URL.createObjectURL(blob); audioObjectURL.current = url;
      setAudioTest({ url, model: value.model, durationMs: value.durationMs }); setNotice(t('speechPanel.testReady'));
    });
    const ttsReady = engine => runtimeInfo.speech.models['tts:' + engine]?.componentsPresent && runtimeInfo.speech.models['tts:' + engine]?.enabled;
    return h(React.Fragment, null,
      h('section', { className: 'bff-card' }, h('div', { className: 'bff-head' }, h('h2', null, t('speechPanel.title')), button('speechPanel.refresh', () => run(loadRuntime))),
        text('speechPanel.localHint'), !runtimeInfo ? text('speechPanel.pending') : unavailable ? h('p', { role: 'alert' }, t('speechPanel.unavailable.' + runtimeInfo.speech.status)) : h(React.Fragment, null,
          h('div', { className: 'bff-table' }, h('table', null,
            h('thead', null, h('tr', null, ...['role', 'model', 'components', 'admission'].map(key => h('th', { key, scope: 'col' }, t('speechPanel.' + key))))),
            h('tbody', null, ...Object.entries(runtimeInfo.speech.models).map(([key, model]) => h('tr', { key },
              h('td', null, key.startsWith('tts:') ? t('speechPanel.tts') : t('speechPanel.' + key)), h('td', null, model.model),
              h('td', null, t(model.componentsPresent ? 'speechPanel.present' : 'speechPanel.missing')),
              h('td', null, t(!model.enabled ? 'disabled' : model.verified ? 'speechPanel.benchmarkPassed' : 'speechPanel.notVerified'))))))),
          text('speechPanel.benchmarkHint'),
          h('form', { onSubmit: event => { event.preventDefault(); if (!paused) return; void run(async () => {
            await request('/speech', speechPayload(runtimeInfo.speech.configurationRevision, speechDraft)); await loadRuntime(); setNotice(t('saved'));
          }); } },
            h('div', { className: 'bff-form-grid' },
              ...[['numThreads', 1, 16], ['maxTextChars', 1, 120]].map(([key, min, max]) => h('label', { key }, h('span', null, t('speechPanel.' + key)), h('input', { type: 'number', min, max, step: 1, required: true, value: speechDraft[key], disabled: busy || !paused, onChange: e => setSpeechDraft({ ...speechDraft, [key]: e.target.value }) })))),
            !paused && text('speechPanel.pauseRequired'),
            h('button', { type: 'submit', disabled: busy || !paused }, t('speechPanel.save'))))),
      runtimeInfo && !unavailable && h('section', { className: 'bff-card' }, h('h2', null, t('speechPanel.voiceTitle')),
        text('speechPanel.voiceHint'), text('speechPanel.conditioningHint'),
        !voices.profiles.length ? h('p', { role: 'status' }, t('speechPanel.noVoices')) : h('div', { className: 'bff-table' }, h('table', null,
          h('thead', null, h('tr', null, ...['voiceLabel', 'voiceLanguage', 'voiceScope', 'voiceReference', 'voiceActions'].map(key => h('th', { key, scope: 'col' }, t('speechPanel.' + key))))),
          h('tbody', null, ...voices.profiles.map(p => h('tr', { key: p.id },
            h('td', null, p.label, ' ', h('code', null, p.id), voices.defaultVoice === p.id ? ' · ' + t('speechPanel.isDefault') : ''),
            h('td', null, p.referenceLanguage), h('td', null, t('speechPanel.scope.' + p.usageScope)),
            h('td', null, t(p.hasReference ? 'speechPanel.referenceOk' : 'speechPanel.referenceMissing')),
            h('td', null, h('div', { className: 'bff-actions' },
              voices.defaultVoice !== p.id && button('speechPanel.makeDefault', () => run(async () => { await request('/voice/default', { expectedRevision: runtimeInfo.speech.configurationRevision, voiceId: p.id }); await loadRuntime(); setNotice(t('saved')); }), { disabled: busy || !paused }),
              button('speechPanel.test', () => audition(p.id), { disabled: busy || !paused || !p.hasReference || !ttsReady(p.engine) }),
              confirmRemove === p.id ? removeConfirmation(p.id) : button('speechPanel.remove', () => setConfirmRemove(p.id), { disabled: busy || !paused || voices.cleanupPending })))))))),
        voices.defaultVoice === null && voices.profiles.length > 0 && text('speechPanel.noDefault'),
        voices.cleanupPending && h(React.Fragment, null, text('speechPanel.cleanupPending'),
          confirmRemove === true ? removeConfirmation(true) : button('speechPanel.retryCleanup', () => setConfirmRemove(true), { disabled: busy || !paused })),
        audioTest && h('div', { className: 'bff-audio' }, h('p', null, `${audioTest.model} · ${(audioTest.durationMs / 1000).toFixed(1)} ${t('speechPanel.seconds')}`), h('audio', { controls: true, preload: 'none', src: audioTest.url, 'aria-label': t('speechPanel.testAudio') })),
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
          !paused && text('speechPanel.pauseRequired'),
          h('button', { type: 'submit', disabled: busy || !paused }, t('speechPanel.upload'))))),
      h('section', { className: 'bff-card' }, h('h2', null, t('speechPanel.imageTitle')), text(runtimeInfo ? 'speechPanel.imageUnavailable' : 'speechPanel.pending')));
  }
  function runtime() {
    return h(React.Fragment, null,
      standalone ? h('section', { className: 'bff-card' }, h('h2', null, t('runtime')), text('standaloneRuntimeHint')) : h(React.Fragment, null, ...[['runtime', 'runtimeHint'], ['strategy', 'strategyHint']].map(([title, hint]) => h('section', { key: title, className: 'bff-card' }, h('h2', null, t(title)), text(hint)))),
      standalone && speechSettings(), modelSettings(),
      h('section', { className: 'bff-card' }, h('h2', null, t('setup')), text(standalone ? 'standaloneSetupHint' : 'setupHint')));
  }
  return h('main', { className: 'bff-world', 'aria-busy': busy }, h('style', null, CSS),
    h('header', { className: 'bff-head' }, h('div', { className: 'bff-actions' }, h(Fish), h('h1', null, t('title'))),
      token && h('div', { className: 'bff-actions' }, button('refresh', () => run(async () => { await load(); if (standalone && tab === 'runtime') await loadRuntime(); })), button('logout', forget))),
    text(standalone ? 'standaloneDescription' : 'description'), error && h('p', { role: 'alert' }, error), h('div', { role: 'status', 'aria-live': 'polite' }, busy ? t('busy') : notice),
    !token ? h('section', { className: 'bff-auth bff-card' }, h('h2', null, t('authorization')), text('authHint'),
      h('form', { onSubmit: event => { event.preventDefault(); if (!input.trim() || busy) return; const credential = input.trim();
        try { sessionStorage.setItem(TOKEN_KEY, credential); } catch {} setToken(credential); setInput('');
      } }, h('label', null, h('span', null, t('token')), h('input', { type: 'password', value: input, onChange: event => setInput(event.target.value), autoComplete: 'off', spellCheck: false, disabled: busy })),
      h('button', { type: 'submit', disabled: busy || !input.trim() }, t('login'))))
      : !data ? h('p', null, busy ? t('loading') : t('error'))
      : h(React.Fragment, null, h('nav', { 'aria-label': t('title') }, ...['overview', 'persona', 'channels', 'memory', 'runtime'].map(key =>
        button(key, () => { if (key !== 'memory') { setMemory(null); setForgetPreview(null); } setTab(key); }, { key, 'aria-current': tab === key ? 'page' : undefined }))),
        tab === 'overview' ? overview() : tab === 'persona' ? persona() : tab === 'channels' ? channels() : tab === 'memory' ? memories() : runtime()));
}
export function flattenDictionary(dictionary, prefix = '') {
  return Object.fromEntries(Object.entries(dictionary).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : Object.entries(flattenDictionary(value, path));
  }));
}

