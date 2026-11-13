// Provider adapters: the paid services besides DeepSeek chat that the gateway may call with a key of
// their own (pictures, video, converted voice). One adapter = one dependency-free module in this
// directory plus one import line here. None exists yet; the list is empty in a release.
//
// An adapter only describes HTTP exchanges. The gateway (../providers.mjs) owns the key, the network
// (hosts, proxy, timeouts, size limits), the spend reservation, the usage ledger and the job list:
//
//   export default {
//     id: 'example',                    // the name its key is stored under
//     title: 'Example',                 // shown on the console
//     hosts: ['api.example.com'],       // every host the gateway may contact for it, result files included
//                                       // (a host also covers its subdomains)
//     proxy: false,                     // true: reached through the host's outbound proxy when one is configured
//     operations: {
//       // '<capability id>.<action>': the capability (capabilities/providers) gives the ledger row, the daily
//       // limit, the spend category and the tier that stops it.
//       'image.generate': {
//         mode: 'sync',                 // 'sync': the submit exchange answers with the result;
//                                       // 'async': it may answer with a task that is polled until it ends
//         estimate(input) {},           // micro-yuan reserved before the call; throws on an input it will not send
//         submit(input, key) {},        // -> { url, method?, headers?, body? } (body: a string)
//         submitted(json, key) {},      // the JSON answer -> an outcome (below)
//         poll(task, key) {},           // async only: -> the request that asks about a task
//         polled(json, key) {},         // async only: its JSON answer -> an outcome
//       },
//     },
//   };
//
// An outcome is one of
//   { state: 'pending', task }          // async: the provider's own task id (only from `submitted`; `polled` omits it)
//   { state: 'failed' }                 // the provider gave up; not charged
//   { state: 'done', outputs, costMicros?, units? }
// `outputs`: 1–8 files, each { url, headers? } (downloaded from one of `hosts` when it is fetched) or
// { base64, mime }. `costMicros`: what the call cost in micro-yuan when the provider reports enough to
// tell; without it the estimate is charged. `units`: numbers for the capability's declared ledger units.
// A function that throws marks a request it will not send or an answer it cannot read.

/** Every provider adapter of this release, in the order an operation is offered to them. */
export const PROVIDERS = Object.freeze([]);
