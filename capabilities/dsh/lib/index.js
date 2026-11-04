import { AuthorityClient } from '../../../authority/src/client.js';
import { ContentClient } from '../../media/client.js';
import { contentTool } from './content.js';
import { loadConfig } from './config.js';
import { createAdapter, proposalTool } from './adapter.js';
import { createDeliveryStore, createSessionDelivery } from './delivery.js';
import { loadQQWorkerConfig, createQQWorkerRoute, qqSessionEpoch } from '../../qq/worker-route.js';
import { createEpochStore, createTurnQuery, boundActiveSurface } from './execution-context.js';

export const name = 'companion-dsh-capability';
export const inject = ['agents', 'tools', 'systemPrompt', 'sessionQuery'];

export async function apply(ctx) {
  const config = await loadConfig();
  const client = new AuthorityClient(config);
  const store = createDeliveryStore(config.deliveryFile);
  const epochs = createEpochStore(config.deliveryFile ? config.deliveryFile + '.epochs.json' : undefined);
  const owned = new Map();
  const attaching = new Map();
  // Channel membership is an Authority binding, not a second local allowlist.
  const rootCompanion = agent => agent.session?.header?.agentPreset === 'companion' && agent.session.id === agent.id && !agent.session.header?.parentSession && agent.session.header?.origin !== 'subagent';
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session?.header?.agentPreset === 'companion' && (!rootCompanion(agent) || !owned.has(agent))) {
      throw Object.assign(new Error('AUTHORITY_BINDING_REQUIRED'), { code: 'AUTHORITY_BINDING_REQUIRED' });
    }
    return next();
  });
  function attach(agent) {
    if (owned.has(agent) || !rootCompanion(agent)) return;
    if (attaching.has(agent)) return attaching.get(agent);
    const session = agent.session;
    const task = (async () => {
      // The operator may enable QQ after Host startup; resolve its current config per attachment.
      const qqConfig = loadQQWorkerConfig();
      const qqEpoch = qqConfig.enabled ? qqSessionEpoch(agent.id, qqConfig.expectedSelfId, qqConfig.allowedCallerUID) : null;
      // Resolve provenance before any history delivery. Unknown roots never become native evidence.
      const route = qqEpoch !== null ? createQQWorkerRoute(qqConfig, qqEpoch) : null;
      if (!route && agent.id.startsWith('qq-private-')) return;
      const sourceClient = route ? new AuthorityClient(route.clientConfig) : client;
      let initialContext;
      try { initialContext = await sourceClient.context({ streamId: route?.streamId || agent.id, budgetChars: 1 });
        if (route && initialContext.memoryEpoch !== qqEpoch) throw new Error('EXECUTION_EPOCH_RETIRED');
        epochs.assert(session, initialContext);
      }
      catch (error) { if (error.status === 403) return; throw error; }
      const adapter = createAdapter(config, sourceClient, {
        contentClient: new ContentClient(route?.clientConfig || config),
        ...(route ? { normalizeEvent: route.normalizeEvent, authorityStreamId: route.streamId, proposalNamespace: 'qq', eventIdFor: route.eventIdFor, requestIdFor: turn => route.currentRequestId(turn) } : {}),
      });
      const delivery = await createSessionDelivery({ adapter, session, store });
      const turnQuery = createTurnQuery();
      const assertToolBoundary = () => {
        const names = agent.ctx.tools.schemas(agent).map(tool => tool.name).sort();
        if (names.length !== 2 || names[0] !== 'companion_content' || names[1] !== 'companion_scope') {
          adapter.clearContext(agent.id);
          throw new Error('CAPABILITY_TOOL_BOUNDARY_INVALID');
        }
      };
      const dispose = agent.ctx.effect(() => {
        const cleanups = [];
        try {
          cleanups.push(agent.ctx.tools.register(proposalTool(adapter, agent, () => delivery.sync())));
          cleanups.push(agent.ctx.tools.register(contentTool(adapter, agent, () => delivery.sync())));
          // Empty allow is an explicit mask (unlike restrict({})). The host
          // implementation filters all inherited layers, not our OWN tool.
          cleanups.push(agent.ctx.tools.restrict({ allow: [] }));
          assertToolBoundary();
        } catch {
          for (const cleanup of cleanups.reverse()) cleanup();
          void delivery.dispose();
          throw new Error('CAPABILITY_TOOL_BOUNDARY_INVALID');
        }
        cleanups.push(agent.ctx.systemPrompt.context({
          name: 'companion-authority', order: 70, required: true,
          text: () => adapter.text(agent.id),
        }));
        cleanups.push(agent.ctx.on('session/event', (incoming, event) => {
          if (incoming === session && session.isOwnSeq(event.seq) && ['user/message', 'assistant/message'].includes(event.type)) {
            // The durable source log is the retry queue. Never discard an event
            // because the bounded in-memory batch or transport is unavailable.
            void delivery.sync().catch(() => {});
          }
        }));
        cleanups.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
          if (payload.agent !== agent) return next();
          payload.signal.throwIfAborted();
          assertToolBoundary();
          const trustedQuery = route?.authorizeStep(payload);
          const query = turnQuery(payload, trustedQuery);
          adapter.clearContext(agent.id);
          let current;
          try { current = await sourceClient.context({ streamId: route?.streamId || agent.id, query, budgetChars: 1 }); }
          catch (error) { if (error.status === 403) throw new Error('AUTHORITY_BINDING_REQUIRED'); throw error; }
          epochs.assert(session, current);
          await delivery.sync();
          await adapter.refresh(agent.id, { query, turn: payload.turn });
          await boundActiveSurface(agent, payload);
          payload.signal.throwIfAborted();
          assertToolBoundary();
          return next();
        }));
        return async () => {
          for (const cleanup of cleanups.reverse()) cleanup();
          await delivery.dispose();
          owned.delete(agent);
        };
      });
      owned.set(agent, dispose);
    })().finally(() => { attaching.delete(agent); });
    attaching.set(agent, task);
    return task;
  }
  ctx.effect(() => async () => {
    await Promise.allSettled([...attaching.values()]);
    await Promise.all([...owned.values()].map(dispose => dispose()));
    owned.clear();
  });
  ctx.on('agent/created', async ({ agent }) => { await attach(agent); });
  for (const agent of ctx.agents.list()) await attach(agent);
  // Dependency marker only; consumers gain no mutable state/admin capability.
  ctx.provide('companionCapabilityReady', Object.freeze({ version: 1 }));
}
