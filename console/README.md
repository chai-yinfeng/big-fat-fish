# Independent Companion world console

The standalone page is the product management entry for the real world/persona/model/QQ/memory view, not a decoration or a second world database. The former DSH settings entry and its legacy `client.js` build were removed with the DSH runtime.

## Build and parent integration

```sh
# From console/; install only local pinned frontend dependencies:
node <bundled-pnpm-script> install --ignore-workspace --ignore-scripts
# Standalone production assets (dist/):
node build.mjs --standalone
node --test *.test.mjs
```

React19.2.0/react-dom19.2.0 are bundled into the standalone page. esbuild0.25.11 bundles and minifies the production browser runtime. The lockfile is local, lifecycle scripts were disabled, and only these necessary frontend dependencies were installed. No global package/profile/VM installation is involved. The pnpm-managed download cache may use the workspace-level store; it is not shipped.

Copy **only** the four flat static outputs from dist/ into the parent release's console-web/ directory:

```text
index.html
console.js
console.css
icon.svg
```

No CDN, source maps, dynamic chunks or extra dev server is needed by the standalone bundle. Parent serves `/` and these fixed assets from its existing operator HTTP listener on3082. API paths remain `/world` etc on the same origin; this also works through a different local SSH-forwarded port. HTTP loopback validation remains mandatory, not an arbitrary-origin bearer client.

Parent should serve static assets without secret-bearing URL logging and with script/connect `self`, style `self` plus inline styles (the view sets a few inline style attributes, e.g. progress widths), media `blob:`, and no framing. No service worker is registered. VM gets compiled assets only, never frontend node_modules.

## Look and interaction

Linear-style dark/light design (tokens in `standalone.css`, after the approved mockup). No webfont or icon font is shipped: Inter is used only if installed, otherwise system fonts; icons are inline SVG in `view.js`; the logo is `icon.svg` (credits and license in `ASSETS.md`). Theme follows the system by default; the sidebar toggle or command palette stores a `light`/`dark` override in localStorage (`companion-world:theme`, display preference only). Navigation is the data-driven `NAV` list in `view.js` (id, icon, G+letter shortcut); a new page adds one entry and one renderer. Cmd/Ctrl-K opens a command palette, `G` then a letter switches pages, Escape closes palette/dialogs/drawer. Notices are toasts, errors stay inline, existing confirmations (memory forget, voice removal/cleanup retry) are modal dialogs, a skeleton shows while a page's data (QQ status, runtime) is loading, and `prefers-reduced-motion` disables animation. Below 860px the sidebar becomes a drawer.

UI tests evaluate the shared view through `test-harness.mjs` with an injected fake React; it is not shipped.

## Authorization and sensitive data

- Before mounting, consume `#companion-operator=<32–256 base64url chars>` once into this tab's sessionStorage and immediately remove the fragment, including malformed matching fragments/storage failures. Unrelated hashes are untouched.
- Only operator access uses sessionStorage; localStorage holds only the theme choice. No API key, reference recording, transcript, memory or diary is persisted in browser storage.
- Bearer goes only to the allowlisted operator paths with `credentials:omit`, `redirect:error`, `cache:no-store`; standalone explicitly selects same-origin mode. Unknown response error messages never render reflected private input.
- DeepSeek uses an uncontrolled password field; it is cleared before sending save/refresh, including request-failure cases. Saved key/suffix is never rendered. Empty preserves the server key. Testing is an explicit possibly-billed action.
- Reference audio, transcript and rights consent are uncontrolled inputs read only on explicit submit. File bytes are locally checked for mono PCM16 WAV,3–20seconds,≤2MiB, then base64 is sent as content—not a pathname or filename. Inputs clear before the request and in finally; bytes/transcript never enter persistent React state/storage. The server remains the format/permission authority.
- Test audio is a bounded WAV response turned into a Blob URL. Controls do not autoplay; replacement, leaving the runtime tab, clearing authorization or unmount revoke the URL. No user media is sent to QQ by these controls.

## Real operations retained

GET/world, world pause/resume, persona edits, model configuration/test, QQ paused/logged-in private-sender binding, and explicit memory/diary operations are retained. Memory is not auto-read with overview; forgetting still previews, requires pause, sends `expectedMemoryEpoch`/`expectedRevision` from the preview and leaves cleanup pending until canonical API state says otherwise. The memory page also reads, without any new write: an owner filter (`GET /memory?person=<opaque label|none>`), older pages (`beforeRevision`, while the response says `more`), and on each item its owner (opaque label as on the People page, never an account number), a Public badge and its source (whose words, which kind of proposal, which channel). What background consolidation wrote is marked as such: a digest carries a "machine digest" badge, her feeling, the time range and number of messages it covers, and has no "authorize public"; an extracted fact is marked as extracted. "Show source messages" reads the observations behind one such item (`GET /memory/sources?id=`) on click, kept only in page state. A status card reads `GET /memory/consolidation` on click: batches today, the spend or daily pause, per conversation (opaque label) what is not consolidated yet, what waits, digests written and batches skipped. The overview's spend card shows the day's token totals and cache hit rate when the gateway reports `tokens`. Pause/resume sends only `{paused}` and persona edits only `{patch}` (every persona field, including examples); `POST /persona/preview` renders an unsaved patch exactly as the context persona block and returns its length against the 2400-character persona budget, without writing. Persona JSON export/import and "load default persona" only fill the editor; saving stays explicit; Authority accepts an optional `expectedRevision` on both and rejects it with 409 only when it is stale. No fake zero counts or status switches substitute for unavailable APIs.

## New controlled runtime contract

All responses use `{ok:true,value}` / safe error envelopes. Standalone loads GET/runtime only on entering Runtime or explicit refresh, not by reading private recordings.

```js
{
  speech: {
    configurationRevision: 'opaque revision', numThreads: 8, maxTextChars: 100,
    models: { 'asr:default': {model,componentsPresent,enabled,verified}, 'tts:llama-tts': {...} }
  },
  voices: {
    defaultVoice: 'actress' /* or null */,
    profiles: [{ id, label, engine, referenceLanguage, usageScope /* private|public */, useReferenceText:false, auditioned, hasReference }],
    cleanupPending:false,
    referenceConditioning:'speaker-file-only', transcriptUsedForSynthesis:false
  },
  imageGeneration:{configured:false,status:'not_configured'}
}
```

- POST/speech `{expectedRevision,numThreads,maxTextChars}`; UI 1–16 threads/1–120 chars, save only paused. Server independently enforces limits and revision. Re-read/runtime after success, never invent a state from the draft.
- POST/voice/reference `{expectedRevision,voiceId,label,language,usageScope,audioBase64,transcript,authorized:true}` registers a new voice; transcript required (≤1000 chars, provenance only), rights checkbox explicitly authorizes local long-term reference storage. Paused only. An existing voice id is rejected; no silent replacement. The first voice becomes the default.
- POST/voice/default `{expectedRevision,voiceId}` sets the default voice.
- POST/voice/test `{voiceId}`; paused only, fixed public sentence, local only, no QQ send/resume/cloud. UI timeout 240 seconds. Result `{audioBase64,mime:'audio/wav',durationMs,model,voiceId}`; optional backend limitation fields do not become quality certification.
- POST/voice/reference/remove `{expectedRevision,voiceId,confirmed:true}` after a separate UI confirmation. Only that voice and its operator-entered reference are removed, not other user media/history/weights; removing the default leaves no default. If `cleanupPending:true`, physical cleanup is unfinished: allow explicit retry (`voiceId` omitted) and prevent new uploads.
- The pinned CPU runner is speaker-file-only. Qwen Base supports cloning, but this adapter does not feed the transcript into full ICL continuation. UI explicitly does not promise exact cloning or naturalness from a successful test.
- Image generation is explicitly not configured. Understanding/sending images is not image generation; no fake enable/generate button exists.

## Test coverage / current limits

- `node --run test:console` (13 checks) covers the retained console behaviors plus standalone asset independence, same-origin/fragment handling, payload shapes, no secret/storage leakage, paused controls, confirmed cleanup and Blob URL revocation.
- Not covered: live browser visual acceptance, real recording upload or deletion, paid model calls and audio playback.
