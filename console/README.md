# Independent Companion world console

Two builds share the real world/persona/model/QQ/memory view. The standalone page is the product management entry, not a decoration or a second world database. The old DSH settings entry remains compatible.

## Build and parent integration

```sh
# From console/; install only local pinned frontend dependencies:
node <bundled-pnpm-script> install --ignore-workspace --ignore-scripts
# Legacy DSH client only (no esbuild import required):
node build.mjs
# Both legacy client and standalone production assets:
node build.mjs --standalone
node --test *.test.mjs
```

React19.2.0/react-dom19.2.0 are bundled into the standalone page because it cannot obtain React from DSH's module loader. esbuild0.25.11 bundles and minifies the production browser runtime. The lockfile is local, lifecycle scripts were disabled, and only these necessary frontend dependencies were installed. No global package/profile/VM installation is involved. The pnpm-managed download cache may use the workspace-level store; it is not shipped.

Copy **only** the four flat static outputs from dist/ into the parent release's console-web/ directory:

```text
index.html
console.js
console.css
icon.svg
```

No CDN, source maps, dynamic chunks, extra dev server, DSH boot, settings slots, DSH RPC or createDshSession is needed by the standalone bundle. Parent serves `/` and these fixed assets from its existing operator HTTP listener on3082. API paths remain `/world` etc on the same origin; this also works through a different local SSH-forwarded port. HTTP loopback validation remains mandatory, not an arbitrary-origin bearer client.

Parent should serve static assets without secret-bearing URL logging and with script/connect `self`, style `self` plus inline styles (the shared React view injects component CSS), media `blob:`, and no framing. No service worker is registered. VM gets compiled assets only, never frontend node_modules.

Legacy build still writes client.js for capability-bundle/client.js and keeps its fixed loopback3082 operator transport. Its settings registration lives only in dsh-entry.js; dsh-client.js remains separate. It may create the old authorized DSH test conversation. Standalone explicitly hides those operations even if a create callback is accidentally supplied, while channel data may truthfully show a DSH execution adapter. A standalone UI does not mean the execution runtime has already removed DSH.

## Authorization and sensitive data

- Before mounting, consume `#companion-operator=<32–256 base64url chars>` once into this tab's sessionStorage and immediately remove the fragment, including malformed matching fragments/storage failures. Unrelated hashes are untouched.
- Only operator access uses sessionStorage. No API key, reference recording, transcript, memory or diary is persisted in browser storage.
- Bearer goes only to the allowlisted operator paths with `credentials:omit`, `redirect:error`, `cache:no-store`; standalone explicitly selects same-origin mode, legacy retains CORS to3082. Unknown response error messages never render reflected private input.
- DeepSeek uses an uncontrolled password field; it is cleared before sending save/refresh, including request-failure cases. Saved key/suffix is never rendered. Empty preserves the server key. Testing is an explicit possibly-billed action.
- Reference audio, transcript and rights consent are uncontrolled inputs read only on explicit submit. File bytes are locally checked for mono PCM16 WAV,3–20seconds,≤2MiB, then base64 is sent as content—not a pathname or filename. Inputs clear before the request and in finally; bytes/transcript never enter persistent React state/storage. The server remains the format/permission authority.
- Test audio is a bounded WAV response turned into a Blob URL. Controls do not autoplay; replacement, leaving the runtime tab, clearing authorization or unmount revoke the URL. No user media is sent to QQ by these controls.

## Real operations retained

GET/world, world pause/resume, persona edits, model configuration/test, QQ paused/logged-in private-sender binding, and explicit memory/diary operations are retained. Memory is not auto-read with overview; forgetting still previews, requires pause, sends `expectedMemoryEpoch`/`expectedRevision` from the preview and leaves cleanup pending until canonical API state says otherwise. Pause/resume sends only `{paused}` and persona edits only `{patch}`; Authority accepts an optional `expectedRevision` on both and rejects it with 409 only when it is stale. No fake zero counts or status switches substitute for unavailable APIs.

## New controlled runtime contract

All responses use `{ok:true,value}` / safe error envelopes. Standalone loads GET/runtime only on entering Runtime or explicit refresh, not by reading private recordings.

```js
{
  speech: {
    configurationRevision: 'opaque revision',
    defaultTtsQuality: 'light' /* or heavy */, numThreads: 2, maxTextChars: 100,
    models: { 'asr:light': {model,componentsPresent,enabled,verified}, /* four known keys */ }
  },
  voice: {
    profileId:'default', origin:'kokoro-local' /* or operator-authorized */,
    hasReference:true, cleanupPending:false,
    // Optional truthful backend limitations:
    referenceConditioning:'speaker-file-only', transcriptUsedForSynthesis:false
  },
  imageGeneration:{configured:false,status:'not_configured'}
}
```

- POST/speech `{expectedRevision,defaultTtsQuality,numThreads,maxTextChars}`; UI1–4threads/1–120chars, save only paused. Server independently enforces limits and revision. Re-read/runtime after success, never invent a state from the draft.
- POST/voice/reference `{expectedRevision,audioBase64,transcript,authorized:true}`; transcript required, client bound≤2000chars, rights checkbox explicitly authorizes local long-term reference storage. Paused only. Existing operator reference must be explicitly removed first; no silent replacement.
- POST/voice/test `{quality:'heavy'}`; paused only, fixed public sentence, local only, no QQ send/resume/cloud. UI timeout240seconds. Result `{audioBase64,mime:'audio/wav',durationMs,model}`; optional backend limitation fields do not become quality certification.
- POST/voice/reference/remove `{expectedRevision,confirmed:true}` after a separate UI confirmation. Only the operator-entered reference is removed and the retained synthetic fallback restored, not other user media/history/weights. If `cleanupPending:true`, explain that fallback already occurred but physical cleanup is unfinished, allow explicit retry, and prevent new reference upload.
- The pinned CPU runner is speaker-file-only. Qwen Base supports cloning, but this adapter does not feed the transcript into full ICL continuation. The transcript registers provenance. UI explicitly does not promise exact cloning or naturalness from a successful test.
- Image generation is explicitly not configured. Understanding/sending images is not image generation; no fake enable/generate button exists.

## Verification and limits

15 relevant checks cover the12 retained console behaviors plus3 standalone tests: artifact independence/local assets, explicit same-origin and fragment handling, exact parameter/audio payloads, no filename/storage/secret rendering, paused controls, confirmation/no-overwrite cleanup, and non-autoplay Blob URL revocation. Compilation and metadata/behavior tests do not replace live browser visual acceptance. No VM, current DSH profile, system browser, real recording upload, actual deletion, paid model call or audio playback was performed by this child; parent owns static hosting, API implementation, deployment and live acceptance.
