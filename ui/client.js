window.__ModuleLoader__.load({
  id: '@local/companion-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const CORE = '/companion-core';
    const ASR = 'http://127.0.0.1:9005';
    const POS_KEY = 'companion-ui:position:v1';
    const DEFAULT_AVATAR_SIZE = 128;
    const POSE_KEY = 'companion-ui:pose:v1';
    const SIZE_KEY = 'companion-ui:size:v1';
    const HOTKEY_KEY = 'companion-ui:hotkey:v1';
    const AUTOFILL_KEY = 'companion-ui:autofill:v1';
    const POSES = [
      { id: 'greet', label: '打招呼' },
      { id: 'listen', label: '倾听' },
      { id: 'wink', label: '眨眼' },
      { id: 'curious', label: '好奇' },
      { id: 'celebrate', label: '开心' },
      { id: 'blush', label: '害羞' },
      { id: 'think', label: '思考' },
      { id: 'busy', label: '忙碌' },
      { id: 'sleep', label: '困困' },
      { id: 'angry', label: '生气' },
    ];

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function defaultPosition(size = DEFAULT_AVATAR_SIZE) {
      const width = typeof window === 'undefined' ? 1200 : window.innerWidth;
      const height = typeof window === 'undefined' ? 800 : window.innerHeight;
      return { x: width - size - 22, y: height - size - 22 };
    }

    function clampPosition(position, size = DEFAULT_AVATAR_SIZE) {
      const width = typeof window === 'undefined' ? 1200 : window.innerWidth;
      const height = typeof window === 'undefined' ? 800 : window.innerHeight;
      return {
        x: clamp(Number(position?.x) || 0, 8, Math.max(8, width - size - 8)),
        y: clamp(Number(position?.y) || 0, 8, Math.max(8, height - size - 8)),
      };
    }

    function loadPosition(size = DEFAULT_AVATAR_SIZE) {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (raw) return clampPosition(JSON.parse(raw), size);
      } catch {}
      return defaultPosition(size);
    }

    function savePosition(position) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(position)); } catch {}
    }

    function snapPosition(position, size = DEFAULT_AVATAR_SIZE) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 12;
      const threshold = 32;
      let { x, y } = clampPosition(position, size);
      if (x < threshold) x = margin;
      else if (width - (x + size) < threshold) x = width - size - margin;
      if (y < threshold) y = margin;
      else if (height - (y + size) < threshold) y = height - size - margin;
      return { x, y };
    }

    function formatClock(totalSeconds) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    async function fetchJson(url, options = {}) {
      const response = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(12_000),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) {
        const message = body && typeof body === 'object' ? (body.error || body.message) : body;
        throw new Error(message || `${response.status} ${response.statusText}`);
      }
      return body;
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
      }
      return btoa(binary);
    }

    function encodeWavFromInt16(chunks) {
      let length = 0;
      for (const chunk of chunks) length += chunk.length;
      const buffer = new ArrayBuffer(44 + length * 2);
      const view = new DataView(buffer);
      const write = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
      };
      write(0, 'RIFF');
      view.setUint32(4, 36 + length * 2, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16_000, true);
      view.setUint32(28, 32_000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, length * 2, true);
      let offset = 44;
      for (const chunk of chunks) {
        for (let index = 0; index < chunk.length; index += 1) {
          view.setInt16(offset, chunk[index], true);
          offset += 2;
        }
      }
      return new Uint8Array(buffer);
    }

    function resampleTo16k(input, inputRate, state) {
      const ratio = inputRate / 16_000;
      let position = state.phase || 0;
      const output = [];
      while (position < input.length) {
        const left = Math.floor(position);
        const right = Math.min(left + 1, input.length - 1);
        const fraction = position - left;
        const sample = input[left] * (1 - fraction) + input[right] * fraction;
        output.push(sample);
        position += ratio;
      }
      state.phase = position - input.length;
      const pcm = new Int16Array(output.length);
      for (let index = 0; index < output.length; index += 1) {
        pcm[index] = Math.max(-32768, Math.min(32767, Math.round(output[index] * 32767)));
      }
      return pcm;
    }

    function createController() {
      return {
        async coreState() {
          try {
            const response = await fetch(`${CORE}/state`, { signal: AbortSignal.timeout(3_500) });
            if (!response.ok) return null;
            return await response.json();
          } catch { return null; }
        },
        async asrHealth() {
          try { return await fetchJson('/companion/asr/health', { signal: AbortSignal.timeout(4_000) }); }
          catch { return null; }
        },
        async asrModels() {
          try { return await fetchJson('/companion/asr/models', { signal: AbortSignal.timeout(4_000) }); }
          catch { return null; }
        },
        async providers() {
          try {
            const [tts, asr] = await Promise.all([
              fetchJson('/companion/tts/providers', { signal: AbortSignal.timeout(3_500) }),
              fetchJson('/companion/asr/providers', { signal: AbortSignal.timeout(3_500) }),
            ]);
            return { ok: true, tts: tts?.tts ?? [], asr: asr?.asr ?? null };
          } catch { return null; }
        },
        async ttsHealth() {
          try { return await fetchJson('/companion/tts/health', { signal: AbortSignal.timeout(4_000) }); }
          catch { return null; }
        },
        async setProviders(patch) {
          if (Array.isArray(patch.tts)) {
            await fetchJson('/companion/tts/providers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tts: patch.tts }),
            });
          }
          if (patch.asr?.providers) {
            await fetchJson('/companion/asr/providers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ providers: patch.asr.providers }),
            });
          }
          return this.providers();
        },
        async installModels(target = 'all') {
          return fetchJson('/companion/asr/models/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target }),
          });
        },
        async diary(limit = 3) {
          try {
            const data = await fetchJson(`${CORE}/diary?limit=${limit}`, { signal: AbortSignal.timeout(3_500) });
            return Array.isArray(data?.entries) ? data.entries : [];
          } catch { return []; }
        },
        async privateDiary(limit = 20) {
          try {
            const data = await fetchJson(`${CORE}/private-diary?limit=${limit}`, { signal: AbortSignal.timeout(3_500) });
            return Array.isArray(data?.entries) ? data.entries : [];
          } catch { return []; }
        },
        async config(patch) {
          return fetchJson(`${CORE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tts: patch }),
          });
        },
        async voice(text) {
          return fetchJson(`${CORE}/voice`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          });
        },
        async restart() {
          const [tts, asr] = await Promise.all([
            fetchJson('/companion/tts/services/restart', { method: 'POST' }),
            fetchJson('/companion/asr/services/restart', { method: 'POST' }),
          ]);
          return { ok: true, services: { ...(tts?.services ?? {}), ...(asr?.services ?? {}) } };
        },
        async asrFile(base64, mime = 'audio/wav', providers = ['qwen3', 'sensevoice']) {
          return fetchJson(`${ASR}/asr`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ audio: base64, mime, language: 'zh', providers }),
            signal: AbortSignal.timeout(60_000),
          });
        },
        async speak(text) {
          try {
            return await fetchJson(`${CORE}/speak`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(90_000),
            });
          } catch {
            const response = await fetch('/companion/tts', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text, voice: 'auto' }),
              signal: AbortSignal.timeout(90_000),
            });
            if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
            await audio.play();
            return { ok: true, browser: true };
          }
        },
      };
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        console.error('[companion-ui]', error);
      }
      render() {
        if (this.state.error) {
          return h('div', {
            className: 'bfish-error',
            style: { position: 'fixed', right: 16, bottom: 16, zIndex: 2147483002, maxWidth: 320 },
          }, `companion-ui 出错：${this.state.error.message || this.state.error}`);
        }
        return this.props.children;
      }
    }

    function InputBridge({ inputActions }) {
      useEffect(() => {
        if (!inputActions) return undefined;
        const onInsert = (event) => {
          const id = event.detail?.id;
          const text = event.detail?.text;
          const mode = event.detail?.mode || 'insert';
          let ok = false;
          try {
            if (typeof text === 'string' && text !== '') {
              if (mode === 'set' && typeof inputActions.setDraft === 'function') {
                inputActions.setDraft(text);
                ok = true;
              } else if (typeof inputActions.captureInsertion === 'function'
                && typeof inputActions.insertText === 'function') {
                const span = inputActions.captureInsertion();
                ok = inputActions.insertText(text, span);
              }
              if (ok && mode === 'submit' && typeof inputActions.submit === 'function') {
                inputActions.submit();
              }
            }
          } catch {
            ok = false;
          }
          window.dispatchEvent(new CustomEvent('companion-ui:insert-result', { detail: { id, ok } }));
        };
        window.addEventListener('companion-ui:insert-text', onInsert);
        return () => window.removeEventListener('companion-ui:insert-text', onInsert);
      }, [inputActions]);
      return null;
    }

    function Avatar({ controller }) {
      const [open, setOpen] = useState(false);
      const [position, setPosition] = useState(loadPosition);
      const [core, setCore] = useState(null);
      const [providers, setProviders] = useState(null);
      const [ttsHealth, setTtsHealth] = useState(null);
      const [asr, setAsr] = useState(null);
      const [tab, setTab] = useState('asr');
      const [pose, setPose] = useState(() => {
        try { return localStorage.getItem(POSE_KEY) || 'auto'; } catch { return 'auto'; }
      });
      const [avatarSize, setAvatarSize] = useState(() => {
        try {
          const saved = Number(localStorage.getItem(SIZE_KEY));
          if (!saved || saved < 128) return DEFAULT_AVATAR_SIZE;
          return clamp(saved, 128, 256);
        } catch { return DEFAULT_AVATAR_SIZE; }
      });
      const [hotkey, setHotkey] = useState(() => {
        try {
          const saved = localStorage.getItem(HOTKEY_KEY);
          if (!saved || saved === 'F8' || saved === 'F9') return 'Control+Alt+Space';
          return saved;
        } catch { return 'Control+Alt+Space'; }
      });
      const [autoFill, setAutoFill] = useState(() => {
        try { return localStorage.getItem(AUTOFILL_KEY) !== '0'; } catch { return true; }
      });
      const [quickOpen, setQuickOpen] = useState(false);
      const [models, setModels] = useState(null);
      const [diary, setDiary] = useState([]);
      const [privateDiary, setPrivateDiary] = useState([]);
      const [showPrivateDiary, setShowPrivateDiary] = useState(false);
      const [outerDiary, setOuterDiary] = useState([]);
      const [showOuterDiary, setShowOuterDiary] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [recording, setRecording] = useState(false);
      const [partial, setPartial] = useState('');
      const [finalText, setFinalText] = useState('');
      const [provider, setProvider] = useState('');
      const [seconds, setSeconds] = useState(0);
      const [busy, setBusy] = useState(false);
      const [ttsEnabled, setTtsEnabled] = useState(true);
      const [voice, setVoice] = useState('auto');
      const [style, setStyle] = useState('');
      const [autoMode, setAutoMode] = useState('first-sentences');
      const [asrLang, setAsrLang] = useState('zh');
      const recRef = useRef(null);
      const stopRequestedRef = useRef(false);
      const configLoadedRef = useRef(false);
      const activeRecordingRef = useRef(false);
      const hoverTimerRef = useRef(null);
      const hoverCloseTimerRef = useRef(null);
      const startRecordingRef = useRef(null);
      const stopRecordingRef = useRef(null);
      const autoFillRef = useRef(autoFill);
      const lastFilledRef = useRef('');
      autoFillRef.current = autoFill;

      const coreDown = core === null;

      useEffect(() => {
        setPosition((current) => clampPosition(current, avatarSize));
        const onResize = () => setPosition((current) => clampPosition(current, avatarSize));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [avatarSize]);

      useEffect(() => {
        try { localStorage.setItem(SIZE_KEY, String(avatarSize)); } catch {}
      }, [avatarSize]);

      useEffect(() => {
        try { localStorage.setItem(HOTKEY_KEY, hotkey); } catch {}
      }, [hotkey]);

      useEffect(() => {
        try { localStorage.setItem(AUTOFILL_KEY, autoFill ? '1' : '0'); } catch {}
      }, [autoFill]);

      useEffect(() => () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
      }, []);

      useEffect(() => {
        let alive = true;
        const refresh = async () => {
          const [state, asrHealth, providerSnapshot, ttsSnapshot] = await Promise.all([
            controller.coreState(),
            controller.asrHealth(),
            controller.providers(),
            controller.ttsHealth(),
          ]);
          if (!alive) return;
          setCore(state);
          setAsr(asrHealth);
          setTtsHealth(ttsSnapshot);
          if (providerSnapshot) setProviders(providerSnapshot);
          if (state?.tts && !configLoadedRef.current) {
            configLoadedRef.current = true;
            setTtsEnabled(state.tts.enabled !== false);
            setVoice(state.tts.voice || 'auto');
            setStyle(state.tts.style || '');
            setAutoMode(state.tts.autoSpeakMode || 'first-sentences');
          }
        };
        refresh();
        const timer = setInterval(refresh, 5_000);
        return () => { alive = false; clearInterval(timer); };
      }, [controller]);

      useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        controller.diary(3).then((entries) => { if (alive) setDiary(entries); });
        const refreshModels = async () => {
          const data = await controller.asrModels();
          if (alive) setModels(data);
        };
        refreshModels();
        const timer = setInterval(refreshModels, 1_500);
        return () => { alive = false; clearInterval(timer); };
      }, [open, controller]);

      useEffect(() => {
        if (!recording) return undefined;
        const timer = setInterval(() => setSeconds((value) => value + 1), 1_000);
        return () => clearInterval(timer);
      }, [recording]);

      useEffect(() => () => {
        const ref = recRef.current;
        if (ref?.shutdown) { try { ref.shutdown(); } catch {} }
      }, []);

      const saveConfig = async (patch) => {
        setError('');
        try {
          const data = await controller.config(patch);
          if (data?.tts) {
            setTtsEnabled(data.tts.enabled !== false);
            setVoice(data.tts.voice || 'auto');
            setStyle(data.tts.style || '');
            setAutoMode(data.tts.autoSpeakMode || 'first-sentences');
          }
        } catch (reason) {
          setError(reason.message || String(reason));
        }
      };

      const updateProviders = async (patch) => {
        setBusy(true);
        setError('');
        try {
          const data = await controller.setProviders(patch);
          setProviders(data);
          setNotice('语音路由已更新');
        } catch (reason) {
          setError(`路由更新失败：${reason.message || reason}`);
        } finally {
          setBusy(false);
        }
      };

      const toggleTtsProvider = (name) => {
        if (!providers?.tts) return;
        const next = providers.tts.map((provider) => (
          provider.name === name ? { ...provider, enabled: !provider.enabled } : provider
        ));
        const disabling = providers.tts.some((provider) => provider.name === name && provider.enabled !== false);
        if (disabling && name === 'mimo' && ['冰糖', '茉莉', '苏打', '白桦'].includes(voice) && core) {
          // A MiMo-only voice cannot be synthesized by edge; fall back to the
          // provider-agnostic auto voice when MiMo is turned off.
          setVoice('auto');
          saveConfig({ voice: 'auto' });
        }
        setProviders({ ...providers, tts: next });
        updateProviders({ tts: next.map(({ name: providerName, enabled }) => ({ name: providerName, enabled })) });
      };

      const moveTtsProvider = (index, delta) => {
        if (!providers?.tts) return;
        const target = index + delta;
        if (target < 0 || target >= providers.tts.length) return;
        const next = [...providers.tts];
        [next[index], next[target]] = [next[target], next[index]];
        setProviders({ ...providers, tts: next });
        updateProviders({ tts: next.map(({ name, enabled }) => ({ name, enabled })) });
      };

      const asrProviders = providers?.asr?.providers
        || [{ name: 'qwen3', enabled: true }, { name: 'zipformer', enabled: true }, { name: 'sensevoice', enabled: true }];
      const enabledAsrProviders = asrProviders
        .filter((provider) => provider.enabled !== false)
        .map((provider) => provider.name);

      const toggleAsrProvider = (name) => {
        const next = asrProviders.map((provider) => (
          provider.name === name ? { ...provider, enabled: !provider.enabled } : provider
        ));
        if (!next.some((provider) => provider.enabled !== false)) {
          setError('至少启用一个 ASR provider');
          return;
        }
        setProviders((current) => ({
          ...(current || {}),
          asr: { ...(current?.asr || {}), providers: next },
        }));
        updateProviders({ asr: { providers: next.map(({ name: providerName, enabled }) => ({ name: providerName, enabled })) } });
      };

      const moveAsrProvider = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= asrProviders.length) return;
        const next = [...asrProviders];
        [next[index], next[target]] = [next[target], next[index]];
        setProviders((current) => ({
          ...(current || {}),
          asr: { ...(current?.asr || {}), providers: next },
        }));
        updateProviders({ asr: { providers: next.map(({ name, enabled }) => ({ name, enabled })) } });
      };

      const insertIntoComposer = (text, mode = 'insert') => new Promise((resolve) => {
        const value = typeof text === 'string' ? text.trim() : '';
        if (!value) { resolve(false); return; }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('companion-ui:insert-result', onResult);
          resolve(ok);
        };
        const onResult = (event) => {
          if (event.detail?.id === id) finish(Boolean(event.detail.ok));
        };
        const timer = setTimeout(() => finish(false), 1_500);
        window.addEventListener('companion-ui:insert-result', onResult);
        window.dispatchEvent(new CustomEvent('companion-ui:insert-text', { detail: { id, text: value, mode } }));
      });

      const fillComposer = async (text = finalText || partial) => {
        const value = String(text || '').trim();
        if (!value) return;
        const ok = await insertIntoComposer(value);
        if (ok) {
          setNotice('已填入 DSH 输入框，确认后按回车发送');
        } else {
          try { await navigator.clipboard.writeText(value); } catch {}
          setNotice('没有找到输入框，已复制转写文本');
        }
      };

      useEffect(() => {
        if (!autoFill || !finalText) return;
        if (lastFilledRef.current === finalText) return;
        lastFilledRef.current = finalText;
        void fillComposer(finalText);
        // fillComposer closes over the current notice/clipboard helpers; the
        // final text is the only trigger that should repeat.
      }, [finalText, autoFill]);

      const startRecording = async () => {
        if (recording || activeRecordingRef.current) return;
        activeRecordingRef.current = true;
        stopRequestedRef.current = false;
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('这个环境不支持麦克风');
          return;
        }
        if (enabledAsrProviders.length === 0) {
          setError('至少启用一个 ASR provider');
          return;
        }
        setError('');
        setNotice('');
        setPartial('');
        setFinalText('');
        setProvider('');
        setSeconds(0);
        setRecording(true);
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (reason) {
          activeRecordingRef.current = false;
          setRecording(false);
          setError(`麦克风不可用：${reason.message || reason}`);
          return;
        }
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.resume().catch(() => {});
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(processor);
        processor.connect(gain);
        gain.connect(audioCtx.destination);
        const ref = {
          stream,
          audioCtx,
          source,
          processor,
          gain,
          ws: null,
          phase: 0,
          chunks: [],
          lastPartial: '',
          finished: false,
          stopped: false,
          timeout: null,
          timer: null,
        };
        recRef.current = ref;

        const finish = (text, sourceName, extra = {}) => {
          if (ref.finished) return;
          ref.finished = true;
          if (ref.timeout) clearTimeout(ref.timeout);
          setFinalText(text || '');
          setPartial(text || '');
          setProvider(sourceName || '');
          activeRecordingRef.current = false;
          setRecording(false);
          try { ref.stop?.(); } catch {}
          try { ref.ws?.close(); } catch {}
          if (extra?.error) setError(extra.error);
        };
        const fallback = async () => {
          if (ref.finished) return;
          const wav = encodeWavFromInt16(ref.chunks);
          if (wav.length <= 44) {
            finish('', '', { error: '没有录到声音' });
            return;
          }
          setNotice('流式连接失败，改用整段识别…');
          try {
            const result = await controller.asrFile(bytesToBase64(wav), 'audio/wav', enabledAsrProviders);
            finish(result.text || '', result.provider || '', { error: result.text ? '' : (result.error || '没有识别到语音') });
          } catch (reason) {
            finish('', '', { error: `整段识别失败：${reason.message || reason}` });
          }
        };
        const stop = () => {
          if (ref.stopped) return;
          ref.stopped = true;
          activeRecordingRef.current = false;
          try { stream.getTracks().forEach((track) => track.stop()); } catch {}
          try { processor.disconnect(); source.disconnect(); gain.disconnect(); } catch {}
          try { audioCtx.close(); } catch {}
          if (ref.ws && ref.ws.readyState === WebSocket.OPEN) {
            try { ref.ws.send(JSON.stringify({ type: 'stop' })); } catch { fallback(); return; }
            ref.timeout = setTimeout(() => {
              if (!ref.finished) fallback();
            }, 15_000);
          } else {
            fallback();
          }
        };
        const shutdown = () => {
          if (!ref.stopped) stop();
          try { ref.ws?.close(); } catch {}
          if (ref.timeout) clearTimeout(ref.timeout);
        };
        ref.stop = stop;
        ref.shutdown = shutdown;

        if (stopRequestedRef.current) {
          try { stream.getTracks().forEach((track) => track.stop()); } catch {}
          try { processor.disconnect(); source.disconnect(); gain.disconnect(); } catch {}
          try { audioCtx.close(); } catch {}
          activeRecordingRef.current = false;
          setRecording(false);
          return;
        }

        const ws = new WebSocket(`${ASR.replace(/^http/, 'ws')}/asr/stream`);
        ref.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ type: 'start', language: asrLang, sampleRate: 16_000, providers: enabledAsrProviders }));
          } catch {}
        };
        ws.onmessage = (event) => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'ready') {
            setNotice(message.cloud ? 'Qwen3-ASR 已连接，正在逐字上屏…' : '本地 SenseVoice 模式，正在识别…');
          } else if (message.type === 'partial') {
            ref.lastPartial = message.text || '';
            setPartial(ref.lastPartial);
          } else if (message.type === 'final') {
            finish(message.text || ref.lastPartial, message.provider || '', { error: message.error || '' });
          } else if (message.type === 'error') {
            setNotice(message.error || '流式识别失败，准备整段重试…');
          }
        };
        ws.onerror = () => {
          if (!ref.finished) setNotice('流式连接异常，停止后会整段重试');
        };
        ws.onclose = () => {
          if (ref.stopped && !ref.finished) {
            // The final may have raced the close; give the fallback a moment.
            setTimeout(() => { if (!ref.finished) fallback(); }, 400);
          }
        };
        processor.onaudioprocess = (event) => {
          if (ref.stopped) return;
          const input = event.inputBuffer.getChannelData(0);
          const pcm = resampleTo16k(input, audioCtx.sampleRate, ref);
          if (pcm.length === 0) return;
          ref.chunks.push(pcm);
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(pcm.buffer); } catch {}
          }
        };
      };

      const stopRecording = () => {
        stopRequestedRef.current = true;
        try { recRef.current?.stop?.(); } catch {}
      };

      startRecordingRef.current = startRecording;
      stopRecordingRef.current = stopRecording;

      useEffect(() => {
        const matches = (event) => {
          const parts = hotkey.split('+');
          const key = parts[parts.length - 1];
          const code = key === 'Space' ? 'Space' : key;
          return event.code === code
            && event.ctrlKey === parts.includes('Control')
            && event.altKey === (parts.includes('Alt') || parts.includes('Option'))
            && event.shiftKey === parts.includes('Shift');
        };
        const down = (event) => {
          if (!matches(event) || event.repeat) return;
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          if (activeRecordingRef.current) return;
          setQuickOpen(false);
          void startRecordingRef.current?.();
        };
        const up = (event) => {
          if (!matches(event)) return;
          event.preventDefault();
          stopRecordingRef.current?.();
        };
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        return () => {
          window.removeEventListener('keydown', down, true);
          window.removeEventListener('keyup', up, true);
        };
      }, [hotkey]);

      const sendTranscript = async () => {
        const text = (finalText || partial).trim();
        if (!text) return;
        setBusy(true);
        setError('');
        try {
          if (core) {
            await controller.voice(text);
            setNotice('已发送给大肥鱼');
            setFinalText('');
            setPartial('');
          } else {
            await navigator.clipboard.writeText(text);
            setNotice('core 未安装，文本已复制');
          }
        } catch (reason) {
          setError(reason.message || String(reason));
        } finally {
          setBusy(false);
        }
      };

      const testTts = async () => {
        setBusy(true);
        setError('');
        try {
          await controller.speak('你好，我是大肥鱼。');
          setNotice('试听已播放');
        } catch (reason) {
          setError(`试听失败：${reason.message || reason}`);
        } finally {
          setBusy(false);
        }
      };

      const restartServices = async () => {
        setBusy(true);
        setError('');
        try {
          await controller.restart();
          setNotice('TTS / ASR 服务已重启');
        } catch (reason) {
          setError(`重启失败：${reason.message || reason}`);
        } finally {
          setBusy(false);
        }
      };

      const installModels = async (target = 'all') => {
        setBusy(true);
        setError('');
        try {
          await controller.installModels(target);
          setNotice(`${target === 'zipformer' ? 'Zipformer' : 'SenseVoice'} 模型下载已开始；保持面板打开可以看到进度。`);
        } catch (reason) {
          setError(`模型下载启动失败：${reason.message || reason}`);
        } finally {
          setBusy(false);
        }
      };

      const clearHoverTimers = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
        hoverTimerRef.current = null;
        hoverCloseTimerRef.current = null;
      };
      const scheduleQuickClose = () => {
        if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = setTimeout(() => setQuickOpen(false), 350);
      };
      const onAvatarEnter = () => {
        if (open || activeRecordingRef.current) return;
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          setQuickOpen(true);
          setOpen(false);
        }, 1_000);
      };
      const onAvatarLeave = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
        if (quickOpen) scheduleQuickClose();
      };
      const onQuickEnter = () => {
        if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = null;
      };
      const onQuickLeave = () => {
        scheduleQuickClose();
      };

      const onPointerDown = (event) => {
        event.preventDefault();
        clearHoverTimers();
        setQuickOpen(false);
        const start = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          x: position.x,
          y: position.y,
          moved: false,
        };
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - start.pointerX;
          const dy = moveEvent.clientY - start.pointerY;
          if (Math.abs(dx) + Math.abs(dy) > 4) start.moved = true;
          setPosition(clampPosition({ x: start.x + dx, y: start.y + dy }, avatarSize));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setPosition((current) => {
            const finalPosition = snapPosition(current, avatarSize);
            savePosition(finalPosition);
            return finalPosition;
          });
          if (!start.moved) setOpen((value) => !value);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
      };

      const panelWidth = 344;
      const quickWidth = 260;
      const width = typeof window === 'undefined' ? 1200 : window.innerWidth;
      const height = typeof window === 'undefined' ? 800 : window.innerHeight;
      const leftCandidate = position.x - panelWidth - 12;
      const rightCandidate = position.x + avatarSize + 12;
      const panelLeft = leftCandidate >= 10
        ? leftCandidate
        : clamp(rightCandidate, 10, Math.max(10, width - panelWidth - 10));
      const panelTop = clamp(position.y + avatarSize - 500, 10, Math.max(10, height - 120));
      const quickLeftCandidate = position.x - quickWidth - 12;
      const quickLeft = quickLeftCandidate >= 10
        ? quickLeftCandidate
        : clamp(position.x + avatarSize + 12, 10, Math.max(10, width - quickWidth - 10));
      const quickTop = clamp(position.y - 16, 10, Math.max(10, height - 390));
      const services = { ...(ttsHealth?.services || {}), ...(asr?.services || {}) };
      const serviceRows = Object.entries(services);
      const servicesUp = serviceRows.length > 0 && serviceRows.every(([, service]) => (
        service.state === 'up' || service.state === 'external'
      ));
      const status = servicesUp ? 'ok' : (serviceRows.length > 0 || core ? 'warn' : 'down');
      const statusColor = status === 'ok' ? '#34d399' : status === 'warn' ? '#fbbf24' : '#f87171';
      const asrModel = models?.sensevoice || asr?.models?.sensevoice;
      const asrInstalled = Boolean(asrModel?.installed);
      const zipModel = models?.zipformer || asr?.models?.zipformer;
      const zipInstalled = Boolean(zipModel?.installed);
      const installState = models?.install || asr?.models?.install;
      const progressTotal = Number(installState?.total) || 0;
      const progressValue = Number(installState?.downloaded) || 0;
      const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressValue / progressTotal) * 100)) : 0;
      const forcedPose = POSES.some((entry) => entry.id === pose) ? pose : null;
      const activePose = recording ? 'listen' : busy ? 'busy' : error ? 'angry' : (forcedPose || 'greet');
      const choosePose = (id) => {
        setPose(id);
        try { localStorage.setItem(POSE_KEY, id); } catch {}
      };
      const switchTab = (next) => {
        if (recording && next !== 'asr') stopRecording();
        setTab(next);
      };

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'bfish-avatar' + (recording ? ' bfish-avatar-recording' : ''),
          style: { left: position.x, top: position.y, width: avatarSize, height: avatarSize },
          title: '大肥鱼',
          'aria-label': '大肥鱼角色面板',
          onPointerDown,
          onPointerEnter: onAvatarEnter,
          onPointerLeave: onAvatarLeave,
        },
          h('img', {
            className: 'bfish-avatar-img',
            src: `/api/companion-ui/assets/pose-${activePose}.webp`,
            alt: '',
            draggable: false,
          }),
          h('span', {
            className: 'bfish-status' + (recording ? ' recording' : ''),
            style: { background: recording ? '#f87171' : statusColor },
            title: recording ? '正在录音' : status === 'ok' ? '语音服务正常' : '语音服务异常',
          }),
        ),
        recording && !open && h('div', {
          className: 'bfish-rec-indicator',
          style: {
            left: clamp(position.x + avatarSize / 2 - 68, 8, Math.max(8, width - 150)),
            top: clamp(position.y + avatarSize + 8, 8, Math.max(8, height - 36)),
          },
        },
          h('span', { className: 'bfish-rec-dot' }),
          `正在录音 ${formatClock(seconds)}`,
        ),
        quickOpen && h('aside', {
          className: 'bfish-quick',
          style: { left: quickLeft, top: quickTop, width: quickWidth },
          onPointerEnter: onQuickEnter,
          onPointerLeave: onQuickLeave,
          'aria-label': '大肥鱼外观',
        },
          h('header', { className: 'bfish-quick-head' },
            h('strong', null, '外观'),
            h('button', { type: 'button', className: 'bfish-icon', onClick: () => setQuickOpen(false), 'aria-label': '关闭外观面板' }, '×'),
          ),
          h('label', { className: 'bfish-quick-size' },
            h('span', null, `大小 ${avatarSize}px`),
            h('input', {
              type: 'range', min: 128, max: 256, step: 8, value: avatarSize,
              onChange: (event) => setAvatarSize(Number(event.target.value)),
            }),
          ),
          h('div', { className: 'bfish-poses' },
            h('button', {
              type: 'button',
              className: 'bfish-pose' + (pose === 'auto' ? ' active' : ''),
              onClick: () => choosePose('auto'),
              title: '自动随状态',
            }, h('span', { className: 'bfish-pose-auto' }, '自动')),
            POSES.map((entry) => h('button', {
              type: 'button',
              key: entry.id,
              className: 'bfish-pose' + (pose === entry.id ? ' active' : ''),
              title: entry.label,
              onClick: () => choosePose(entry.id),
            }, h('img', { src: `/api/companion-ui/assets/pose-${entry.id}.webp`, alt: entry.label }))),
          ),
          h('button', {
            type: 'button',
            className: 'bfish-btn primary',
            onClick: () => { setQuickOpen(false); setOpen(true); setTab('asr'); },
          }, '打开管理面板'),
          h('div', { className: 'bfish-hint' }, '悬浮头像 1 秒打开；拖动头像可移动并吸附边缘。'),
        ),
        open && h('section', {
          className: 'bfish-panel',
          style: { left: panelLeft, top: panelTop, width: panelWidth },
          'aria-label': '大肥鱼面板',
        },
          h('header', { className: 'bfish-head' },
            h('div', null,
              h('strong', null, '大肥鱼'),
              h('span', { className: 'bfish-sub' }, core?.ready ? '陪伴内核已连接' : 'companion-core 未连接'),
            ),
            h('button', {
              type: 'button',
              className: 'bfish-icon',
              onClick: () => { if (recording) stopRecording(); setOpen(false); },
              'aria-label': '关闭',
            }, '×'),
          ),
          h('nav', { className: 'bfish-tabs' },
            h('button', { type: 'button', className: 'bfish-tab' + (tab === 'asr' ? ' active' : ''), onClick: () => switchTab('asr') }, 'ASR'),
            h('button', { type: 'button', className: 'bfish-tab' + (tab === 'tts' ? ' active' : ''), onClick: () => switchTab('tts') }, 'TTS'),
            h('button', { type: 'button', className: 'bfish-tab' + (tab === 'status' ? ' active' : ''), onClick: () => switchTab('status') }, '状态'),
          ),
          coreDown && h('div', { className: 'bfish-banner' },
            'core 未安装：语音测试/识别仍可用；记忆、心情、绑定不可用。',
          ),
          error && h('div', { className: 'bfish-error' }, error),
          notice && h('div', { className: 'bfish-notice' }, notice),

          tab === 'asr' && h(React.Fragment, null,
            h('div', { className: 'bfish-section' },
              h('h4', null, 'ASR 路由'),
              asrProviders.map((provider, index) => h('div', { className: 'bfish-provider', key: provider.name },
                h('label', { className: 'bfish-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: provider.enabled !== false,
                    disabled: busy || recording,
                    onChange: () => toggleAsrProvider(provider.name),
                  }),
                  h('span', null, provider.name === 'qwen3'
                    ? 'Qwen3 云端（付费）'
                    : provider.name === 'zipformer'
                      ? 'Zipformer 本地流式（免费）'
                      : provider.name === 'sensevoice'
                        ? 'SenseVoice 本地（免费）'
                        : provider.name),
                ),
                h('span', { className: 'bfish-order' },
                  h('button', { type: 'button', className: 'bfish-mini', disabled: busy || index === 0, onClick: () => moveAsrProvider(index, -1), 'aria-label': '上移' }, '↑'),
                  h('button', { type: 'button', className: 'bfish-mini', disabled: busy || index === asrProviders.length - 1, onClick: () => moveAsrProvider(index, 1), 'aria-label': '下移' }, '↓'),
                ),
              )),
              h('div', { className: 'bfish-hint' }, '勾选表示允许走这条，顺序即优先级；只勾 SenseVoice 就不会调用付费 Qwen3。'),
            ),

            h('div', { className: 'bfish-section' },
              h('h4', null, '语音识别'),
              h('div', { className: 'bfish-row' },
                h('span', null, 'Zipformer 本地流式'),
                h('span', { className: 'bfish-pill ' + (zipInstalled ? 'ok' : 'warn') }, zipInstalled ? '已安装' : '未安装'),
              ),
              !zipInstalled && h('button', {
                type: 'button',
                className: 'bfish-btn',
                disabled: busy || installState?.installing,
                onClick: () => installModels('zipformer'),
              }, installState?.installing && installState?.target === 'zipformer'
                ? `Zipformer 下载中 ${progressPercent}%`
                : '下载 Zipformer（约 74MB）'),
              installState?.installing && installState?.target === 'zipformer' && h('div', { className: 'bfish-progress' },
                h('div', { className: 'bfish-progress-bar', style: { width: `${progressPercent}%` } }),
              ),
              h('div', { className: 'bfish-row', style: { marginTop: '8px' } },
                h('span', null, 'SenseVoice 模型'),
                h('span', { className: 'bfish-pill ' + (asrInstalled ? 'ok' : 'warn') }, asrInstalled ? '已安装' : '未安装'),
              ),
              !asrInstalled && h('button', {
                type: 'button',
                className: 'bfish-btn',
                disabled: busy || installState?.installing,
                onClick: () => installModels('sensevoice'),
              }, installState?.installing && installState?.target === 'sensevoice'
                ? `SenseVoice 下载中 ${progressPercent}%`
                : '下载 SenseVoice（约 228MB）'),
              installState?.installing && installState?.target === 'sensevoice' && h('div', { className: 'bfish-progress' },
                h('div', { className: 'bfish-progress-bar', style: { width: `${progressPercent}%` } }),
              ),
              installState?.error && h('div', { className: 'bfish-error' }, installState.error),
              h('label', { className: 'bfish-field' }, '语言',
                h('select', {
                  className: 'bfish-input',
                  value: asrLang,
                  disabled: recording,
                  onChange: (event) => setAsrLang(event.target.value),
                },
                  h('option', { value: 'zh' }, '中文'),
                  h('option', { value: 'en' }, 'English'),
                  h('option', { value: 'auto' }, '自动'),
                ),
              ),
              h('label', { className: 'bfish-field' }, '录音快捷键',
                h('select', {
                  className: 'bfish-input',
                  value: hotkey,
                  onChange: (event) => setHotkey(event.target.value),
                },
                  h('option', { value: 'Control+Alt+Space' }, 'Control + Option + Space'),
                  h('option', { value: 'Alt+Shift+Space' }, 'Option + Shift + Space'),
                  h('option', { value: 'Alt+Space' }, 'Option + Space'),
                  h('option', { value: 'F8' }, 'F8'),
                  h('option', { value: 'F9' }, 'F9'),
                ),
              ),
              h('div', { className: 'bfish-hint' }, 'Option+Space 被 ChatGPT/Codex 的 Toggle Mini 占用时，先在其快捷键设置里清除；F8/F9 可能被系统媒体键占用。'),
              h('div', { className: 'bfish-hint' }, `窗口聚焦时按住 ${hotkey} 说话；松开后自动填入 DSH 输入框。全局热键需要原生壳。`),
              h('label', { className: 'bfish-check', style: { margin: '4px 0' } },
                h('input', {
                  type: 'checkbox',
                  checked: autoFill,
                  onChange: (event) => setAutoFill(event.target.checked),
                }),
                h('span', null, '识别后自动填入输入框'),
              ),
              h('button', {
                type: 'button',
                className: 'bfish-rec' + (recording ? ' recording' : ''),
                onPointerDown: (event) => { event.preventDefault(); startRecording(); },
                onPointerUp: (event) => { event.preventDefault(); stopRecording(); },
                onPointerLeave: () => { if (recording) stopRecording(); },
                onPointerCancel: () => { if (recording) stopRecording(); },
              }, recording ? `● 录音中 ${formatClock(seconds)}（松开发送）` : '按住说话'),
              (partial || finalText) && h('div', { className: 'bfish-transcript' },
                h('div', { className: 'bfish-muted' }, provider ? `识别来源：${provider}` : '逐字上屏'),
                h('div', null, finalText || partial),
              ),
              (finalText || partial) && h('div', { className: 'bfish-actions' },
                h('button', { type: 'button', className: 'bfish-btn primary', disabled: busy || recording, onClick: () => fillComposer() }, '填入输入框'),
                h('button', { type: 'button', className: 'bfish-btn', disabled: busy || recording, onClick: sendTranscript }, core ? '直接发送' : '复制文本'),
                h('button', { type: 'button', className: 'bfish-btn', disabled: busy || recording, onClick: () => { setFinalText(''); setPartial(''); setProvider(''); } }, '重录'),
              ),
            ),
          ),

          tab === 'tts' && h(React.Fragment, null,
            h('div', { className: 'bfish-section' },
              h('h4', null, 'TTS 路由'),
              providers?.tts?.length
                ? providers.tts.map((provider, index) => {
                  const health = ttsHealth?.providers?.find((item) => item.name === provider.name);
                  const [pillClass, pillLabel] = provider.enabled === false
                    ? ['warn', '关闭']
                    : health?.ok === false
                      ? ['bad', '不可用']
                      : health?.configured === false
                        ? ['warn', '未配置']
                        : health
                          ? ['ok', '已配置']
                          : ['warn', '未知'];
                  return h('div', { className: 'bfish-provider', key: provider.name },
                    h('div', { className: 'bfish-provider-main' },
                      h('label', { className: 'bfish-check' },
                        h('input', {
                          type: 'checkbox',
                          checked: provider.enabled !== false,
                          disabled: busy,
                          onChange: () => toggleTtsProvider(provider.name),
                        }),
                        h('span', null, provider.name === 'mimo' ? 'MiMo（云端/限时免费）' : provider.name === 'qwen' ? 'Qwen3-TTS（百炼）' : provider.name === 'minimax' ? 'MiniMax' : provider.name === 'edge' ? 'edge（免费）' : provider.name),
                      ),
                      h('span', { className: 'bfish-pill ' + pillClass }, pillLabel),
                    ),
                    h('span', { className: 'bfish-order' },
                      h('button', { type: 'button', className: 'bfish-mini', disabled: busy || index === 0, onClick: () => moveTtsProvider(index, -1), 'aria-label': '上移' }, '↑'),
                      h('button', { type: 'button', className: 'bfish-mini', disabled: busy || index === providers.tts.length - 1, onClick: () => moveTtsProvider(index, 1), 'aria-label': '下移' }, '↓'),
                    ),
                  );
                })
                : h('div', { className: 'bfish-muted' }, '未配置 TTS provider'),
              h('div', { className: 'bfish-hint' }, '勾选表示允许走这条，顺序即优先级；取消 MiMo 只走 edge。'),
            ),

            h('div', { className: 'bfish-section' },
              h('h4', null, '语音合成'),
              h('label', { className: 'bfish-check', style: { margin: '4px 0 8px' } },
                h('input', {
                  type: 'checkbox',
                  checked: ttsEnabled,
                  disabled: busy,
                  onChange: (event) => {
                    const next = event.target.checked;
                    setTtsEnabled(next);
                    saveConfig({ enabled: next });
                  },
                }),
                h('span', null, '语音输出总开关（关闭后所有自动朗读都静音）'),
              ),
              h('label', { className: 'bfish-field' }, '音色',
                h('select', {
                  className: 'bfish-input',
                  value: voice,
                  disabled: !core || busy,
                  onChange: (event) => { setVoice(event.target.value); saveConfig({ voice: event.target.value }); },
                },
                  h('option', { value: 'auto' }, 'auto（provider 默认）'),
                  h('option', { value: '冰糖' }, 'MiMo 冰糖'),
                  h('option', { value: '茉莉' }, 'MiMo 茉莉'),
                  h('option', { value: '苏打' }, 'MiMo 苏打'),
                  h('option', { value: '白桦' }, 'MiMo 白桦'),
                  h('option', { value: 'Cherry' }, 'Qwen Cherry'),
                  h('option', { value: 'Ethan' }, 'Qwen Ethan'),
                  h('option', { value: 'female-shaonv' }, 'MiniMax 少女'),
                  h('option', { value: 'zh-CN-XiaoxiaoNeural' }, 'edge Xiaoxiao'),
                ),
              ),
              h('label', { className: 'bfish-field' }, '风格（MiMo）',
                h('input', {
                  className: 'bfish-input',
                  value: style,
                  disabled: !core || busy,
                  onChange: (event) => setStyle(event.target.value),
                  onBlur: () => core && saveConfig({ style }),
                  placeholder: '温柔、自然，像在跟亲近的人说话',
                }),
              ),
              h('label', { className: 'bfish-field' }, '自动朗读',
                h('select', {
                  className: 'bfish-input',
                  value: autoMode,
                  disabled: !core || busy,
                  onChange: (event) => { setAutoMode(event.target.value); saveConfig({ autoSpeakMode: event.target.value, autoSpeak: event.target.value !== 'off' }); },
                },
                  h('option', { value: 'first-sentences' }, '开头完整句子'),
                  h('option', { value: 'full' }, '整段截断'),
                  h('option', { value: 'short-only' }, '只念短回复'),
                  h('option', { value: 'off' }, '关闭'),
                ),
              ),
              h('button', { type: 'button', className: 'bfish-btn', disabled: busy || !ttsEnabled, onClick: testTts }, '试听'),
              core?.tts?.lastAutoSpeak && h('div', { className: 'bfish-hint' },
                core.tts.lastAutoSpeak.error
                  ? `上次自动朗读失败：${core.tts.lastAutoSpeak.error}`
                  : core.tts.lastAutoSpeak.skipped
                    ? `上次自动朗读跳过：${core.tts.lastAutoSpeak.skipped}`
                    : `上次自动朗读：${core.tts.lastAutoSpeak.ok ? `${core.tts.lastAutoSpeak.chars} 字` : '等待中'}`,
              ),
            ),
          ),

          tab === 'status' && h(React.Fragment, null,
            h('div', { className: 'bfish-section' },
              h('h4', null, '语音服务'),
              serviceRows.length > 0
                ? serviceRows.map(([name, info]) => h('div', { className: 'bfish-row', key: name },
                  h('span', null, name),
                  h('span', { className: 'bfish-pill ' + (info.state === 'up' || info.state === 'external' ? 'ok' : info.state === 'error' ? 'bad' : 'warn') }, info.state === 'external' ? '外部/运行中' : info.state),
                ))
                : h('div', { className: 'bfish-muted' }, serviceRows.length > 0 ? 'TTS/ASR sidecar 已加载' : '暂无语音 sidecar'),
              core && h('button', { type: 'button', className: 'bfish-btn', disabled: busy, onClick: restartServices }, '重启语音服务'),
            ),
            h('div', { className: 'bfish-section' },
              h('h4', null, 'ASR 依赖'),
              h('div', { className: 'bfish-row' },
                h('span', null, 'Qwen3 云端'),
                h('span', { className: 'bfish-pill ' + (asr?.qwen?.configured ? 'ok' : 'warn') }, asr ? (asr.qwen?.configured ? '已配置' : '未配置') : '未知'),
              ),
              h('div', { className: 'bfish-row' },
                h('span', null, 'Zipformer 本地流式'),
                h('span', { className: 'bfish-pill ' + (asr?.zipformer?.available ? 'ok' : 'warn') }, asr ? (asr.zipformer?.available ? '已加载' : asr.zipformer?.installed ? '已安装' : '未安装') : '未知'),
              ),
              h('div', { className: 'bfish-row' },
                h('span', null, 'SenseVoice 本地'),
                h('span', { className: 'bfish-pill ' + (asr?.sensevoice?.available ? 'ok' : 'warn') }, asr ? (asr.sensevoice?.available ? '已加载' : asr.sensevoice?.installed ? '已安装' : '未安装') : '未知'),
              ),
              h('div', { className: 'bfish-row' },
                h('span', null, 'Silero VAD'),
                h('span', { className: 'bfish-pill ' + (asr?.vad?.available ? 'ok' : 'warn') }, asr ? (asr.vad?.available ? '可用' : '缺失') : '未知'),
              ),
              h('div', { className: 'bfish-hint' }, '服务行是进程；Qwen3 是云端 API，SenseVoice/VAD 是 ASR 网关里的模型。'),
            ),
            core && h('div', { className: 'bfish-section' },
              h('h4', null, '私密日记'),
              h('div', { className: 'bfish-muted' }, 'inner diary 默认不在公开 API；只有你能主动打开这里查看。'),
              h('button', {
                type: 'button',
                className: 'bfish-btn',
                onClick: async () => {
                  if (!showPrivateDiary) {
                    const entries = await controller.privateDiary(20);
                    setPrivateDiary(entries);
                  }
                  setShowPrivateDiary((value) => !value);
                },
              }, showPrivateDiary ? '收起' : '偷偷看一眼'),
              showPrivateDiary && h('div', {
                className: 'bfish-diary-modal',
                onClick: (event) => { if (event.target === event.currentTarget) setShowPrivateDiary(false); },
              },
                h('div', { className: 'bfish-diary-window', role: 'dialog', 'aria-label': '私密日记' },
                  h('div', { className: 'bfish-diary-window-head' },
                    h('strong', null, '私密日记'),
                    h('button', { type: 'button', className: 'bfish-btn', onClick: () => setShowPrivateDiary(false) }, '关闭'),
                  ),
                  privateDiary.length > 0
                    ? privateDiary.map((entry) => h('div', { key: entry.id, className: 'bfish-diary-line', title: entry.text }, `${entry.date}｜${entry.text}`))
                    : h('div', { className: 'bfish-muted' }, '还没有 inner diary。'),
                ),
              ),
            ),
            core
              ? h('div', { className: 'bfish-section' },
                h('h4', null, '陪伴状态'),
                h('div', { className: 'bfish-muted' }, core.mood?.text || ''),
                h('div', { className: 'bfish-muted' }, `facts ${core.counts?.facts ?? 0} / diary ${core.counts?.diary ?? 0} / episodes ${core.counts?.episodes ?? 0}`),
                h('div', { className: 'bfish-muted', title: (core.boundSessions?.length ? core.boundSessions.join('\n') : '') }, core.boundSessions?.length > 1 ? `已绑定 ${core.boundSessions.length} 个会话：${core.boundSessions.join('、')}` : core.bound ? `已绑定：${core.bound}` : '未绑定：用“大肥鱼陪伴”模式新建会话，或 /companion bind'),
                h('button', {
                  type: 'button',
                  className: 'bfish-btn',
                  onClick: async () => {
                    if (!showOuterDiary) {
                      const entries = await controller.diary(50);
                      setOuterDiary(entries);
                    }
                    setShowOuterDiary((value) => !value);
                  },
                }, showOuterDiary ? '收起公开日记' : `打开公开日记（${core.counts?.diary ?? 0}）`),
                showOuterDiary && h('div', {
                  className: 'bfish-diary-modal',
                  onClick: (event) => { if (event.target === event.currentTarget) setShowOuterDiary(false); },
                },
                  h('div', { className: 'bfish-diary-window', role: 'dialog', 'aria-label': '公开日记' },
                    h('div', { className: 'bfish-diary-window-head' },
                      h('strong', null, '公开日记'),
                      h('button', { type: 'button', className: 'bfish-btn', onClick: () => setShowOuterDiary(false) }, '关闭'),
                    ),
                    outerDiary.length > 0
                      ? outerDiary.map((entry) => h('div', { key: entry.id || entry.at, className: 'bfish-diary-line', title: entry.text }, `${entry.date}｜${entry.text}`))
                      : h('div', { className: 'bfish-muted' }, '还没有 outer diary。'),
                  ),
                ),
              )
              : h('div', { className: 'bfish-section' },
                h('h4', null, '陪伴状态'),
                h('div', { className: 'bfish-muted' }, 'companion-core 未安装，记忆/心情不可用。'),
              ),
          ),
        ),
      );
    }

    const CSS = `
.bfish-avatar{position:fixed;z-index:2147483000;width:128px;height:128px;padding:2px;border:0;border-radius:22px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;pointer-events:auto;transition:transform .15s ease;filter:drop-shadow(0 8px 14px rgba(0,0,0,.45))}
.bfish-avatar-img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;user-select:none}
.bfish-avatar:hover{transform:scale(1.05);box-shadow:0 14px 36px rgba(0,0,0,.45)}
.bfish-avatar:active{cursor:grabbing}
.bfish-avatar-recording{animation:bfish-pulse 1.4s ease-in-out infinite}
@keyframes bfish-pulse{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.45)}50%{box-shadow:0 0 0 12px rgba(52,211,153,0)}}
.bfish-status{position:absolute;right:2px;bottom:2px;width:12px;height:12px;border-radius:50%;border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(10,20,36,.5)}
.bfish-status.recording{animation:bfish-rec-pulse 1.2s ease-in-out infinite}
@keyframes bfish-rec-pulse{0%,100%{box-shadow:0 0 0 0 rgba(248,113,113,.55)}50%{box-shadow:0 0 0 9px rgba(248,113,113,0)}}
.bfish-rec-indicator{position:fixed;z-index:2147483003;pointer-events:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(10,20,36,.92);border:1px solid rgba(248,113,113,.35);color:#fecaca;font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.bfish-rec-dot{width:7px;height:7px;border-radius:50%;background:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.2)}
.bfish-quick{position:fixed;z-index:2147483002;max-height:68vh;overflow:auto;border:1px solid rgba(148,163,184,.25);border-radius:16px;background:rgba(10,20,36,.96);color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.55);padding:12px;font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;pointer-events:auto;backdrop-filter:blur(16px)}
.bfish-quick-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.bfish-quick-head strong{font-size:14px}
.bfish-quick-size{display:flex;flex-direction:column;gap:4px;color:#cbd5e1;font-size:12px;margin-bottom:6px}
.bfish-quick-size input{width:100%;accent-color:#22d3ee}
.bfish-quick-field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;color:#cbd5e1;font-size:12px}
.bfish-quick-field .bfish-input{max-width:130px}
.bfish-panel{position:fixed;z-index:2147483001;max-width:min(380px,calc(100vw - 24px));max-height:72vh;overflow:auto;border:1px solid rgba(148,163,184,.25);border-radius:18px;background:rgba(10,20,36,.96);color:#e2e8f0;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:14px;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;pointer-events:auto;backdrop-filter:blur(16px)}
.bfish-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px}
.bfish-head strong{font-size:16px}
.bfish-sub{display:block;color:#94a3b8;font-size:11px;margin-top:1px}
.bfish-icon{border:0;background:transparent;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
.bfish-banner,.bfish-error,.bfish-notice{border-radius:10px;padding:7px 9px;margin:6px 0;font-size:12px}
.bfish-banner{background:rgba(251,191,36,.12);color:#fde68a;border:1px solid rgba(251,191,36,.3)}
.bfish-error{background:rgba(248,113,113,.12);color:#fecaca;border:1px solid rgba(248,113,113,.3)}
.bfish-notice{background:rgba(52,211,153,.1);color:#a7f3d0;border:1px solid rgba(52,211,153,.25)}
.bfish-tabs{display:flex;gap:4px;margin:8px 0 4px;padding-bottom:6px;border-bottom:1px solid rgba(148,163,184,.18)}
.bfish-tab{border:0;background:transparent;color:#94a3b8;padding:4px 10px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px}
.bfish-tab.active{background:rgba(34,211,238,.14);color:#a5f3fc}
.bfish-section{border-top:1px solid rgba(148,163,184,.18);margin-top:10px;padding-top:8px}
.bfish-section h4{margin:0 0 6px;font-size:12px;color:#94a3b8;letter-spacing:.04em;text-transform:uppercase}
.bfish-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0}
.bfish-pill{border-radius:999px;padding:1px 8px;font-size:11px;background:rgba(148,163,184,.16);color:#cbd5e1}
.bfish-pill.ok{background:rgba(52,211,153,.15);color:#6ee7b7}
.bfish-pill.warn{background:rgba(251,191,36,.15);color:#fde68a}
.bfish-pill.bad{background:rgba(248,113,113,.15);color:#fecaca}
.bfish-muted{color:#94a3b8;font-size:12px;margin:3px 0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.bfish-row>span:first-child{min-width:0;overflow-wrap:anywhere;word-break:break-word}
.bfish-field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}
.bfish-field>span{color:#cbd5e1;font-size:12px}
.bfish-input{flex:1;min-width:0;border:1px solid rgba(148,163,184,.28);border-radius:9px;background:rgba(15,23,42,.85);color:#e2e8f0;padding:6px 8px;font:inherit;outline:none}
.bfish-input:focus{border-color:#22d3ee}
.bfish-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid rgba(148,163,184,.3);border-radius:9px;background:rgba(30,41,59,.8);color:#e2e8f0;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;margin-top:6px}
.bfish-btn:hover{background:rgba(51,65,85,.9)}
.bfish-btn:disabled{opacity:.45;cursor:not-allowed}
.bfish-btn.primary{background:#0e7490;border-color:#22d3ee;color:#ecfeff}
.bfish-rec{width:100%;border:1px solid rgba(52,211,153,.35);border-radius:12px;background:rgba(6,78,59,.45);color:#d1fae5;padding:12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px;touch-action:none}
.bfish-rec.recording{background:rgba(127,29,29,.6);border-color:rgba(248,113,113,.5);color:#fee2e2}
.bfish-transcript{border:1px solid rgba(148,163,184,.2);border-radius:10px;background:rgba(2,6,23,.55);padding:8px;margin-top:8px;min-height:44px;white-space:pre-wrap;word-break:break-word}
.bfish-actions{display:flex;gap:8px;flex-wrap:wrap}
.bfish-progress{height:5px;background:rgba(148,163,184,.18);border-radius:99px;overflow:hidden;margin:6px 0}
.bfish-progress-bar{height:100%;background:#22d3ee;transition:width .3s ease}
.bfish-diary{margin-top:6px;border-top:1px dashed rgba(148,163,184,.2);padding-top:6px}
.bfish-diary-modal{position:fixed;inset:0;z-index:2147483004;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(2,6,23,.72);backdrop-filter:blur(6px)}
.bfish-diary-window{position:relative;width:min(720px,100%);max-height:82vh;overflow-y:auto;overflow-x:hidden;padding:16px 20px;border:1px solid rgba(148,163,184,.28);border-radius:16px;background:rgba(10,20,36,.99);color:#e2e8f0;box-shadow:0 28px 90px rgba(0,0,0,.7);font:13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}
.bfish-diary-window .bfish-diary-line{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.bfish-diary-window-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(148,163,184,.2)}
.bfish-diary-line{color:#cbd5e1;font-size:12px;padding:3px 0;border-bottom:1px dashed rgba(148,163,184,.12);white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.bfish-provider{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0}
.bfish-provider-main{display:flex;align-items:center;gap:6px;min-width:0}
.bfish-check{display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer}
.bfish-check input{accent-color:#22d3ee}
.bfish-order{display:flex;gap:4px}
.bfish-mini{border:1px solid rgba(148,163,184,.3);border-radius:6px;background:rgba(30,41,59,.7);color:#cbd5e1;font-size:11px;padding:1px 6px;cursor:pointer}
.bfish-mini:disabled{opacity:.3;cursor:not-allowed}
.bfish-hint{color:#64748b;font-size:11px;margin-top:5px;line-height:1.45}
.bfish-poses{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:6px}
.bfish-pose{aspect-ratio:1;border:1px solid rgba(148,163,184,.22);border-radius:9px;background:rgba(15,23,42,.6);padding:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden}
.bfish-pose img{width:100%;height:100%;object-fit:contain;display:block}
.bfish-pose.active{border-color:#22d3ee;box-shadow:inset 0 0 0 1px #22d3ee}
.bfish-pose-auto{font-size:11px;color:#cbd5e1}
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        const controller = createController();
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-companion-ui', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'companion-ui: styles');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'companion-ui:avatar',
          order: 50,
        }, () => h(ErrorBoundary, null, h(Avatar, { controller }))));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'companion-ui:input-bridge',
          order: 90,
        }, (props) => h(InputBridge, { inputActions: props.inputActions })));
      },
    };
  },
});
