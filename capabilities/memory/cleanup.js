// Only operator-created, previewed forget jobs reach this trusted host component.
// Neither diary model output nor ordinary memory proposals can invoke it.
export class MemoryCleanup {
  constructor({ operator, purge, stopExecution, startExecution }) {
    Object.assign(this, { operator, purge, stopExecution, startExecution });
    this.running = false;
  }
  async runOnce() {
    if (this.running) return { status: 'running' };
    this.running = true;
    let completed = 0;
    try {
      const jobs = await this.operator('/memory/cleanup/pending');
      for (const plan of jobs) {
        const world = await this.operator('/world');
        if (!world.world.paused) return { status: 'pause_required', completed };
        await this.stopExecution();
        try {
          const report = await this.purge(plan);
          if (report.sdkPurged !== true || report.localSourcesPurged !== true) return { status: 'pending', completed };
          await this.operator('/memory/cleanup/complete', { id: plan.id, memoryEpoch: plan.memoryEpoch, report: { sdkPurged: true, localSourcesPurged: true, platform: 'outside-control' } });
          completed++;
        } finally { await this.startExecution(); }
      }
      return { status: 'complete', completed };
    } catch { return { status: 'pending', completed }; }
    finally { this.running = false; }
  }
}
