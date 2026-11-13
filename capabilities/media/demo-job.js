// The demonstration job: waits N seconds, one second a slice, and returns a fixed text. It exists to walk the
// background-job path end to end (register, queue, yield, finish, tell the person) before a real capability does.
const fail = code => Object.assign(new Error(code), { code });
export const DEMO_RESULT = '演示任务完成：等待结束。这是一段固定的演示文本，由后台任务生成，不是任何人说的话。';
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});
export function createDemoRunner({ sleep = wait, sliceMs = 1000 } = {}) {
  return {
    title: '演示任务', action: 'wait', priority: 'yielding', deadlineMs: 10 * 60000,
    input(raw = {}) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'seconds')) throw fail('MEDIA_INPUT_INVALID');
      const seconds = raw.seconds ?? 5;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw fail('MEDIA_INPUT_INVALID');
      return { seconds };
    },
    async run({ input, stage }) {
      await stage('wait', (input.seconds + 30) * sliceMs, async step => {
        for (let done = 1; done <= input.seconds; done++) { await step.slice(signal => sleep(sliceMs, signal)); step.progress(done / input.seconds * 100); }
      });
      return { text: DEMO_RESULT };
    },
  };
}
