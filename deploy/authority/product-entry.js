// Copied to capability-bundle/index.js; paths are relative to the full release.
import { apply as applyCapability, inject as capabilityInject } from '../capabilities/dsh/lib/index.js';
import { loadConfig } from '../capabilities/dsh/lib/config.js';
import { AuthorityClient } from '../authority/src/client.js';
import { loadQQWorkerConfig, createQQWorkerRoute, qqSessionId } from '../capabilities/qq/worker-route.js';
export const name = 'companion-native-capability';
export const inject = [...capabilityInject, 'commands'];
export async function apply(ctx) {
  await applyCapability(ctx);
  const config = await loadConfig();
  const client = new AuthorityClient(config);
  ctx.effect(() => ctx.commands.register({
    name: 'companion', description: 'Inspect this native capability and its Authority connection; no state mutation.',
    input: { hint: 'status' },
    async handler({ rawInput, agent }) {
      if (String(rawInput || '').trim() !== 'status' || agent.session?.header?.agentPreset !== 'companion' || agent.session?.id !== agent.id || agent.session.header?.parentSession || agent.session.header?.origin === 'subagent') return { kind: 'error', text: 'Only status on a configured native stream is supported.' };
      try {
        const qq = loadQQWorkerConfig();
        const route = qq.enabled && agent.id === qqSessionId(qq.expectedSelfId, qq.allowedCallerUID) ? createQQWorkerRoute(qq) : null;
        const sourceClient = route ? new AuthorityClient(route.clientConfig) : client;
        const context = await sourceClient.context({ streamId: route?.streamId || agent.id, query: '', budgetChars: 2400 });
        const toolNames = ctx.tools.schemas(agent).map(tool => tool.name).sort();
        if (toolNames.length !== 1 || toolNames[0] !== 'companion_scope') throw new Error('BOUNDARY');
        return { kind: 'success', text: JSON.stringify({ authorityRevision: context.revision, personaRevision: context.personaRevision, world: context.world, audience: context.scope.audience, tools: toolNames, directSystemAccess: false }) };
      } catch { return { kind: 'error', text: 'Authority unavailable or capability boundary invalid; no fallback identity.' }; }
    },
  }));
}
