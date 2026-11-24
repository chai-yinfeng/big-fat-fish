// One process's side of forgetting while the services stay up (PROTOCOL.md "Operator API and forgetting"): a
// channel's bridge or its conversation executor asks Authority, with the channel's own capability credential, for the
// cleanup jobs it has not confirmed, forgets its own files of each inside its own process, and confirms. Authority
// keeps who has confirmed; the world cannot resume before every party has.

/** `authority`: an AuthorityClient. `party`: 'bridge' or 'executor'. `forget(job)` erases this process's files of
 * `{ id, memoryEpoch, affectedStreams: [{ streamId, memoryEpoch }], sourceEvents: [{ streamId, eventId }] }` and
 * returns its counts (numbers only); it must be safe to run again for the same job. */
export function createCleanupParty({ authority, party, forget }) {
  let round = null;
  async function run() {
    let completed = 0;
    // A job this party has confirmed is not handed out again, so this ends; the bound is for a broken peer.
    for (let i = 0; i < 32; i++) {
      const { job } = await authority.cleanupNext({ party });
      if (!job) break;
      const report = await forget(job);
      await authority.cleanupAck({ id: job.id, memoryEpoch: job.memoryEpoch, party, report });
      completed++;
    }
    return completed;
  }
  return {
    /** One round, one at a time (a second caller gets the round under way). Never throws: whatever fails leaves the
     * job pending at Authority, and the next round asks again. -> { completed, failed? } */
    runOnce() {
      return round ??= run().then(completed => ({ completed }), error => ({ completed: 0, failed: typeof error?.code === 'string' ? error.code : 'FAILED' })).finally(() => { round = null; });
    },
  };
}
