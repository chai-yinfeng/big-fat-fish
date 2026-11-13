// Capability registry: the one place that lists what the companion can do beyond plain text.
// One directory per capability, each with a declaration (manifest.js): a dependency-free data
// object saying what it is called, which actions it has, how it is metered, where its credentials
// live (locations only, never values), what it produces and what it needs to run.
//
// Adding a capability = one directory with a manifest, plus one import line here.
//
// A capability served by a paid provider other than DeepSeek chat is reached through a provider adapter
// (model-gateway/providers/index.mjs). The link is the name: an adapter operation `<capability id>.<action>`
// is counted and limited by that capability's `meter` here (source 'gateway', a spendCategory), and its
// credential entry points at `model-data/providers.json`. None is declared yet.
//
// `proactive` is not something the model calls: it is the usage row and spend category of a run she starts herself.
//
// Today the declarations are read by the usage ledger (model-gateway/usage-ledger.mjs) and, through
// it, the console's quota page. The model tools, Authority's /v1/content allowlist and the content
// service still carry their own action lists.
import chat from './chat/manifest.js';
import consolidation from './consolidation/manifest.js';
import vision from './vision/manifest.js';
import web from './web/manifest.js';
import speechTts from './speech-tts/manifest.js';
import speechAsr from './speech-asr/manifest.js';
import proactive from './proactive/manifest.js';

const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
/** Every declared capability, in the order the quota page lists them. */
export const CAPABILITIES = frozen([chat, consolidation, vision, web, speechTts, speechAsr, proactive]);
