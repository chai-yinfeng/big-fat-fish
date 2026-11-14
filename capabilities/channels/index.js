// Channel registry: the one place that says what each chat channel is like. One directory per channel, each
// with a declaration (manifest.js): a dependency-free data object. A channel's id is the id of its Authority
// capability (policy conversation.v1); its bridge is the adapter that speaks the platform.
//
// A declaration is a description, not behaviour:
//   expression  what a reply can carry there: voice, images, small faces, and whether a long reply is split
//   friends     the platform has a friend relation, so its bridge may admit a friend as a person; `account` is
//               then the shape of an account name there (a regular expression source). Only QQ and WeChat-like
//               channels have it; anything else is null and people are bound by the operator.
//   receipts    'reliable': the platform answers each send with a receipt. 'unreliable' (a client driven from
//               outside, for instance): a send without a confirmed receipt is `unknown` and is never sent again.
//   prompt      the channel's part of the system message: fixed text from this repository, the same bytes on
//               every request of that channel (provider prefix cache), at most CHANNEL_PROMPT_CHARS.
//   turnPolicy  fixed lines the bridge adds to a turn's input (e.g. when the reply will be spoken).
//   testOnly    never a production channel: Authority's entry point (and the deploy preflight) refuse a
//               configuration that registers it unless that configuration also sets operator.allowTestChannels
//               (the staging tools and the tests do; nothing in a release writes it), and no release contains
//               a bridge for it.
//
// Adding a channel = one directory with a manifest, plus one import line here.
import qq from './qq/manifest.js';
import mock from './mock/manifest.js';

const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
/** Longest channel part of the system message. */
export const CHANNEL_PROMPT_CHARS = 600;
/** Every declared channel. */
export const CHANNELS = frozen([qq, mock]);
/** The declaration of one channel, or null. */
export const channel = id => CHANNELS.find(item => item.id === id) ?? null;
/** The channel's part of the system message ('' for an unknown channel or one without any). */
export const channelPrompt = id => { const text = channel(id)?.prompt; return typeof text === 'string' && text.length <= CHANNEL_PROMPT_CHARS ? text : ''; };
