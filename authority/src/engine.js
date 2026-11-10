import { randomUUID } from 'node:crypto';
import { Store, DEFAULT_ENTITY_ID } from './store.js';
import { capability, canonical, closed, contextScope, enumeration, fail, identifier, integer, jsonValue, resolveIdentity, text } from './identity.js';
import { POLICIES, validatePayload, review } from './policies.js';
import { normalizePersona, validatePersonaPatch } from '../../core/src/persona.js';
import { renderContextParts, DEFAULT_CONTEXT_CHARS, personaShare, personaContextText, opaquePerson, opaqueStream } from './context.js';
import { MemoryDomain } from './memory.js';
export {
  DEFAULT_ENTITY_ID
}
from './store.js';
export const MAX_ADMITTED_PEOPLE = 40;
/** Size of the in-memory injection trace (newest context() calls; gone on restart). */
export const TRACE_LIMIT = 400;
export class Authority extends MemoryDomain {
  constructor(options){
    super();
    closed(options,['file','clock','persona','initialPaused','migrations'],['file']);
    text(options.file,4096);
    if(options.initialPaused!==undefined&&typeof options.initialPaused!=='boolean')fail('VALIDATION_ERROR','initialPaused must be boolean');
    if(options.clock!==undefined&&typeof options.clock!=='function')fail('VALIDATION_ERROR','clock must be function');
    this.clock=options.clock??Date.now;
    jsonValue(options.persona??{});
    const persona=validated(()=>normalizePersona(options.persona??{})),
    at=this.now();
    this.store=new Store(options.file,{
      world:{
        paused:options.initialPaused??false,revision:1,anchorWorldAt:at,anchorRealAt:at
      },persona,personaRevision:1,facts:[],experiences:[],notes:[],appraisals:[],relationships:{}
    },options.migrations?{
      migrations:options.migrations
    }:{});
    this.processing=false;
    this.traces=[];
    this.traceSeq=0;
  }
  now(){
    return integer(this.clock());
  }
  worldStatus(){
    const w=this.store.get('state').world,
    realNow=this.now();
    return{
      paused:w.paused,
      revision:w.revision,
      worldNow:w.anchorWorldAt+(w.paused?0:realNow-w.anchorRealAt),
      realNow
    };
  }
  setWorldPaused(input){
    closed(input,['paused','expectedRevision'],['paused']);
    if(input.expectedRevision!==undefined)integer(input.expectedRevision,1);
    if(typeof input.paused!=='boolean')fail('VALIDATION_ERROR','paused must be boolean');
    return this.store.transaction(()=>{
      if(input.paused===false&&this.store.db.prepare("SELECT 1 FROM cleanup_jobs WHERE status='pending' LIMIT 1").get())fail('CONFLICT','Complete controlled cleanup before resuming',409);
      const state=this.store.get('state');
      if(input.expectedRevision!==undefined&&state.world.revision!==input.expectedRevision)fail('CONFLICT','World revision conflicts',409);
      const status=this.worldStatus();
      if(status.paused===input.paused)return status;
      state.world={
        paused:input.paused,revision:status.revision+1,anchorWorldAt:status.worldNow,anchorRealAt:status.realNow
      };
      this.store.set('state',state);
      this.store.audit({
        type:'world.pause',paused:input.paused,worldRevision:state.world.revision,revision:this.store.nextRevision(),at:status.realNow
      });
      return{
        ...status,paused:input.paused,revision:state.world.revision
      };
    });
  }
  registerCapability(input){
    closed(input,['id','policy']);
    identifier(input.id);
    enumeration(input.policy,POLICIES);
    return this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT * FROM capabilities WHERE id=?').get(input.id);
      if(old){
        if(old.policy!==input.policy)fail('CONFLICT','Capability conflicts',409);
        return{
          ...input
        };
      }
      this.store.db.prepare('INSERT INTO capabilities(id,policy) VALUES(?,?)').run(input.id,input.policy);
      this.adminAudit('capability.register',input);
      return{
        ...input
      };
    });
  }
  bindActor(input){
    closed(input,['capabilityId','externalActorId','personId']);
    identifier(input.externalActorId);
    identifier(input.personId);
    return this.store.transaction(()=>{
      capability(this.store,input.capabilityId);
      const old=this.store.db.prepare('SELECT person_id FROM actors WHERE capability_id=? AND actor_id=?').get(input.capabilityId,input.externalActorId);
      if(old){
        if(old.person_id!==input.personId)fail('CONFLICT','Actor binding conflicts',409);
        return{
          ...input
        };
      }
      this.store.db.prepare('INSERT INTO actors(capability_id,actor_id,person_id) VALUES(?,?,?)').run(input.capabilityId,input.externalActorId,input.personId);
      this.adminAudit('actor.bind',input);
      return{
        ...input
      };
    });
  }
  bindStream(input){
    closed(input,['capabilityId','streamId','personId','audience','entityId'],['capabilityId','streamId','personId','audience']);
    identifier(input.streamId);
    identifier(input.personId);
    enumeration(input.audience,['private','shared']);
    const entityId=input.entityId??DEFAULT_ENTITY_ID;
    this.entity(entityId);
    return this.store.transaction(()=>{
      capability(this.store,input.capabilityId);
      const old=this.store.db.prepare('SELECT * FROM streams WHERE capability_id=? AND stream_id=?').get(input.capabilityId,input.streamId);
      if(old){
        if(old.person_id!==input.personId||old.audience!==input.audience||old.entity_id!==entityId)fail('CONFLICT','Stream binding conflicts; create a new conversation binding',409);
        return{
          ...input,entityId
        };
      }
      this.store.db.prepare('INSERT INTO streams(capability_id,stream_id,person_id,audience,entity_id) VALUES(?,?,?,?,?)').run(input.capabilityId,input.streamId,input.personId,input.audience,entityId);
      this.adminAudit('stream.bind',{
        ...input,entityId
      });
      return{
        ...input,entityId
      };
    });
  }
  /** QQ-only: admit a bot friend as `person:qq:<uid>` with its own private conversation.
   * The QQ worker decides friendship (same trust boundary as actor IDs); the bot
   * account comes from the owner's existing binding, never from the request. */
  admitPerson(capabilityId,input){
    closed(input,['uid']);
    if(typeof input.uid!=='string'||!/^[1-9]\d{0,19}$/.test(input.uid))fail('VALIDATION_ERROR','Invalid QQ account');
    const registered=capability(this.store,capabilityId);
    if(capabilityId!=='qq'||registered.policy!=='conversation.v1')fail('FORBIDDEN','Admission is QQ-only',403);
    return this.store.transaction(()=>{
      const owner=this.store.db.prepare("SELECT a.actor_id AS actorId,s.entity_id AS entityId FROM actors a LEFT JOIN streams s ON s.capability_id=a.capability_id AND s.person_id=a.person_id AND s.audience='private' WHERE a.capability_id=? AND a.person_id='person:owner' ORDER BY a.rowid DESC").all(capabilityId)
        .map(row=>({...row,match:/^qq:([1-9]\d{0,19}):user:[1-9]\d{0,19}$/.exec(row.actorId)})).find(row=>row.match);
      if(!owner)fail('CONFLICT','Bind the owner before admitting people',409);
      const self=owner.match[1],actorId=`qq:${self}:user:${input.uid}`,streamId=`qq:${self}:private:${input.uid}`,entityId=owner.entityId??DEFAULT_ENTITY_ID;
      const actor=this.store.db.prepare('SELECT person_id FROM actors WHERE capability_id=? AND actor_id=?').get(capabilityId,actorId),
      stream=this.store.db.prepare('SELECT person_id,audience FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId,streamId);
      const personId=actor?.person_id??`person:qq:${input.uid}`;
      if(stream&&(stream.person_id!==personId||stream.audience!=='private'))fail('CONFLICT','Conversation binding conflicts',409);
      if(actor&&stream)return{personId,streamId,admitted:false};
      if(!actor){
        const count=this.store.db.prepare("SELECT COUNT(DISTINCT person_id) AS n FROM actors WHERE capability_id=? AND person_id LIKE 'person:qq:%'").get(capabilityId).n;
        if(count>=MAX_ADMITTED_PEOPLE)fail('PEOPLE_LIMIT','Admitted people limit reached',409);
        this.store.db.prepare('INSERT INTO actors(capability_id,actor_id,person_id) VALUES(?,?,?)').run(capabilityId,actorId,personId);
      }
      if(!stream)this.store.db.prepare('INSERT INTO streams(capability_id,stream_id,person_id,audience,entity_id) VALUES(?,?,?,?,?)').run(capabilityId,streamId,personId,'private',entityId);
      this.adminAudit('person.admit',{capabilityId,personId,actorId,streamId,entityId});
      return{personId,streamId,admitted:true};
    });
  }
  /** Operator-only listing: people derived from actor bindings (no persons table). */
  listPeople(){
    this.store.check();
    const people=new Map();
    for(const row of this.store.db.prepare('SELECT capability_id AS capabilityId,actor_id AS externalActorId,person_id AS personId FROM actors ORDER BY rowid').all()){
      if(!people.has(row.personId))people.set(row.personId,{personId:row.personId,label:opaquePerson(row.personId),owner:row.personId==='person:owner',actors:[],conversations:0});
      people.get(row.personId).actors.push({capabilityId:row.capabilityId,externalActorId:row.externalActorId});
    }
    for(const row of this.store.db.prepare('SELECT person_id AS personId,COUNT(*) AS n FROM streams GROUP BY person_id').all())if(people.has(row.personId))people.get(row.personId).conversations=row.n;
    return{people:[...people.values()],limit:MAX_ADMITTED_PEOPLE,admitted:[...people.keys()].filter(id=>id.startsWith('person:qq:')).length};
  }
  /** Operator-only listing of bound conversations with their activity and memory epoch. */
  listConversations(){
    this.store.check();
    return this.store.db.prepare(`SELECT s.capability_id AS capabilityId,s.stream_id AS streamId,s.person_id AS personId,s.audience,s.entity_id AS entityId,
      (SELECT COUNT(*) FROM observations o WHERE o.capability_id=s.capability_id AND o.stream_id=s.stream_id AND o.forgotten=0) AS messages,
      (SELECT MAX(json_extract(o.body,'$.at')) FROM observations o WHERE o.capability_id=s.capability_id AND o.stream_id=s.stream_id) AS lastAt
      FROM streams s ORDER BY s.capability_id,s.stream_id`).all().map(row=>({...row,label:opaquePerson(row.personId),owner:row.personId==='person:owner',memoryEpoch:this.streamEpoch(this.entity(row.entityId),row.capabilityId,row.streamId)}))
      .sort((a,b)=>(b.lastAt??0)-(a.lastAt??0));
  }
  adminAudit(type,input){
    this.store.audit({
      type,...input,revision:this.store.nextRevision(),at:this.now()
    });
  }
  revisePersona(input){
    closed(input,['entityId','expectedRevision','patch','reason'],['patch','reason']);
    if(input.expectedRevision!==undefined)integer(input.expectedRevision,1);
    text(input.reason,1000);
    jsonValue(input.patch);
    validated(()=>validatePersonaPatch(input.patch));
    return this.store.transaction(()=>{
      const e=this.entity(input.entityId??DEFAULT_ENTITY_ID);
      if(input.expectedRevision!==undefined&&e.persona_revision!==input.expectedRevision)fail('CONFLICT','Persona revision conflicts',409);
      const persona=validated(()=>normalizePersona({
        ...JSON.parse(e.persona),...input.patch
      })),personaRevision=e.persona_revision+1;
      this.store.db.prepare('UPDATE entities SET persona=?,persona_revision=? WHERE id=?').run(JSON.stringify(persona),personaRevision,e.id);
      const revision=this.store.nextRevision();
      this.store.audit({
        type:'persona.revision',entityId:e.id,revision,personaRevision,patch:input.patch,reason:input.reason,at:this.now()
      });
      return{
        entityId:e.id,revision,personaRevision,persona
      };
    });
  }
  /** Read-only: the persona block a patch would render into context, and its share of the default budget. */
  previewPersona(input){
    closed(input,['entityId','patch'],['patch']);
    jsonValue(input.patch);
    validated(()=>validatePersonaPatch(input.patch));
    const e=this.entity(input.entityId??DEFAULT_ENTITY_ID),
    text=personaContextText(validated(()=>normalizePersona({...JSON.parse(e.persona),...input.patch})));
    return{text,chars:text.length,limit:personaShare(DEFAULT_CONTEXT_CHARS)};
  }
  contentScope(capabilityId, input) {
    closed(input, ['streamId', 'memoryEpoch', 'sourceEventId'], ['streamId', 'memoryEpoch']);
    identifier(input.streamId); integer(input.memoryEpoch);
    if (capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Content capability is not granted', 403);
    const scope = contextScope(this.store, capabilityId, input.streamId), entity = this.entity(scope.entityId), world = this.worldStatus(), memoryEpoch = this.streamEpoch(entity, capabilityId, input.streamId);
    if (world.paused || memoryEpoch !== input.memoryEpoch) fail('CONFLICT', 'Content scope is paused or retired', 409);
    if (input.sourceEventId !== undefined) {
      identifier(input.sourceEventId);
      const source = this.store.db.prepare('SELECT body,forgotten FROM observations WHERE capability_id=? AND stream_id=? AND event_id=?').get(capabilityId, input.streamId, input.sourceEventId);
      if (!source || source.forgotten || !resolveIdentity(this.store, capabilityId, JSON.parse(source.body)).confirmed) fail('FORBIDDEN', 'Content source is unavailable', 403);
    }
    return { ...scope, capabilityId, memoryEpoch, worldRevision: world.revision };
  }
  observe(capabilityId,input){
    capability(this.store,capabilityId);
    closed(input,['eventId','streamId','actorId','role','text','at','origin'], ['eventId','streamId','actorId','role','text','at']);
    if (input.origin !== undefined) enumeration(input.origin, ['attachment']);
    for(const f of ['eventId','streamId','actorId'])identifier(input[f]);
    enumeration(input.role,['user','assistant','external']);
    text(input.text,32000);
    integer(input.at);
    const encoded=canonical(input);
    return this.store.transaction(()=>{
      const binding = this.store.db.prepare('SELECT entity_id FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, input.streamId);
      const tombstone = this.store.db.prepare('SELECT observation_id FROM source_tombstones WHERE entity_id=? AND capability_id=? AND stream_id=? AND event_id=?').get(binding?.entity_id ?? DEFAULT_ENTITY_ID, capabilityId, input.streamId, input.eventId);
      if (tombstone) return { observationId: tombstone.observation_id, duplicate: true, forgotten: true };
      const previous=this.store.db.prepare('SELECT * FROM observations WHERE capability_id=? AND stream_id=? AND event_id=?').get(capabilityId,input.streamId,input.eventId);
      if(previous){
        if(previous.forgotten)return{
          observationId:previous.id,duplicate:true,forgotten:true
        };
        if(previous.canonical!==encoded)fail('CONFLICT','Event identifier reused with different content',409);
        return{
          observationId:previous.id,duplicate:true
        };
      }
      const stream=this.store.db.prepare('SELECT entity_id FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId,input.streamId);
      const entityId=stream?.entity_id??DEFAULT_ENTITY_ID,id=randomUUID();
      this.store.db.prepare('INSERT INTO observations(id,capability_id,stream_id,event_id,canonical,body,entity_id) VALUES(?,?,?,?,?,?,?)').run(id,capabilityId,input.streamId,input.eventId,encoded,JSON.stringify(input),entityId);
      return{
        observationId:id,duplicate:false
      };
    });
  }
  submit(capabilityId,input){
    capability(this.store,capabilityId);
    closed(input,['proposalId','observationId','type','payload']);
    identifier(input.proposalId);
    identifier(input.observationId);
    validated(()=>validatePayload(input.type,input.payload));
    const encoded=canonical(input);
    return this.store.transaction(()=>{
      const previous=this.store.db.prepare('SELECT * FROM inbox WHERE capability_id=? AND proposal_id=?').get(capabilityId,input.proposalId);
      if(previous){
        if(!previous.forgotten&&previous.canonical!==encoded)fail('CONFLICT','Proposal reused with different content',409);
        return JSON.parse(previous.receipt);
      }
      const observation=this.store.db.prepare('SELECT * FROM observations WHERE id=?').get(input.observationId);
      if(!observation||observation.capability_id!==capabilityId||observation.forgotten)fail('FORBIDDEN','Observation unavailable',403);
      const policy=capability(this.store,capabilityId).policy,paused=this.worldStatus().paused,receipt={
        proposalId:input.proposalId,status:paused?'rejected':'pending',policy,...(paused?{
          revision:this.store.nextRevision(),reason:'world_paused'
        }
        :{})
      };
      this.store.db.prepare('INSERT INTO inbox(capability_id,proposal_id,observation_id,canonical,body,policy,status,receipt,entity_id) VALUES(?,?,?,?,?,?,?,?,?)').run(capabilityId,input.proposalId,input.observationId,encoded,JSON.stringify(input),policy,receipt.status,JSON.stringify(receipt),observation.entity_id);
      if(paused)this.store.audit({
        type:'proposal.resolved',capabilityId,proposalId:input.proposalId,observationId:input.observationId,entityId:observation.entity_id,revision:receipt.revision,status:'rejected',reason:'world_paused',effects:[]
      });
      return receipt;
    });
  }
  getReceipt(capabilityId,proposalId){
    capability(this.store,capabilityId);
    identifier(proposalId);
    const row=this.store.db.prepare('SELECT receipt FROM inbox WHERE capability_id=? AND proposal_id=?').get(capabilityId,proposalId);
    return row?JSON.parse(row.receipt):null;
  }
  processPending(input={}){
    closed(input,['limit'],[]);
    const limit=integer(input.limit===undefined?32:input.limit,1,256);
    if(this.processing)fail('CONFLICT','Reviewer is already processing',409);
    if(this.store.get('state').world.paused)return[];
    this.processing=true;
    try{
      return this.store.db.prepare("SELECT seq FROM inbox WHERE status='pending' ORDER BY seq LIMIT ?").all(limit).map(({
        seq
      })=>this.store.transaction(()=>{
        const row=this.store.db.prepare('SELECT * FROM inbox WHERE seq=?').get(seq),source=this.store.db.prepare('SELECT * FROM observations WHERE id=?').get(row.observation_id),observation={
          ...JSON.parse(source.body),id:source.id
        };
         const alreadyAppraised=Boolean(this.store.db.prepare("SELECT 1 FROM memory_items m JOIN memory_sources s ON m.id=s.memory_id WHERE m.entity_id=? AND m.collection='appraisals' AND s.observation_id=? LIMIT 1").get(row.entity_id,source.id));
         const identity = resolveIdentity(this.store, row.capability_id, observation);
        const decision=source.forgotten?{
          status:'rejected',reason:'source_forgotten',effects:[]
        }
        : identity.stream && identity.stream.entityId !== row.entity_id ? { status: 'rejected', reason: 'source_entity_mismatch', effects: [] }
        :review({
          policy:row.policy,proposal:JSON.parse(row.body),observation,identity,state:{
            alreadyAppraised
          }
        }),revision=this.store.nextRevision(),at=this.now(),worldAt=this.worldStatus().worldNow;
         const effects=decision.effects.map(({
          collection,...effect
        })=>{
          const entry={
            ...effect,id:randomUUID(),capabilityId:row.capability_id,proposalId:row.proposal_id,revision,at
          };
           if(collection==='facts')for(const old of this.store.db.prepare("SELECT id FROM memory_items WHERE entity_id=? AND collection='facts' AND person_id=? AND json_extract(body,'$.key')=? AND status='active'").all(row.entity_id,entry.personId,entry.key)){
            this.store.db.prepare("UPDATE memory_items SET status='superseded',superseded_by=? WHERE id=?").run(entry.id,old.id);
            this.store.db.prepare('DELETE FROM memory_tokens WHERE memory_id=?').run(old.id);
          }
          this.store.insertMemory(row.entity_id,collection,entry,worldAt);
          if(collection==='appraisals'){
            const p=this.store.db.prepare('SELECT body FROM relationships WHERE entity_id=? AND person_id=?').get(row.entity_id,entry.personId),previous=p?JSON.parse(p.body):{
              score:0
            };
            this.store.db.prepare('INSERT OR REPLACE INTO relationships(entity_id,person_id,body) VALUES(?,?,?)').run(row.entity_id,entry.personId,JSON.stringify({
              score:Math.min(100,previous.score+entry.delta),revision,policy:row.policy,evidence:entry.evidence
            }));
          }
          return{
            collection,id:entry.id
          };
        });
         const receipt={
          proposalId:row.proposal_id,status:decision.status,revision,policy:row.policy,...(decision.reason?{
            reason:decision.reason
          }
          :{})
        };
        this.store.db.prepare('UPDATE inbox SET status=?,receipt=? WHERE seq=?').run(receipt.status,JSON.stringify(receipt),seq);
        this.store.audit({
          type:'proposal.resolved',entityId:row.entity_id,capabilityId:row.capability_id,proposalId:row.proposal_id,observationId:source.id,policy:row.policy,revision,at,status:decision.status,...(decision.reason?{
            reason:decision.reason
          }
          :{}),effects
        });
        return receipt;
      }));
    }
    finally{
      this.processing=false;
    }
  }
  context(capabilityId,input){
    closed(input,['streamId','query','budgetChars'],['streamId']);
    const registered=capability(this.store,capabilityId),
    scope=contextScope(this.store,capabilityId,input.streamId),
    e=this.entity(scope.entityId),
    query=input.query===undefined?'':input.query;
    text(query,2000,true);
    const budget=integer(input.budgetChars===undefined?DEFAULT_CONTEXT_CHARS:input.budgetChars,0,16000),
    rows=this.candidates(scope,registered.policy,query,64),
    {sections,...rendered}=renderContextParts(JSON.parse(e.persona),rows,budget),
    result={
      revision:this.store.get('revision'),
      entityId:e.id,
      memoryEpoch:this.streamEpoch(e,capabilityId,input.streamId),
      personaRevision:e.persona_revision,
      // `text` is the whole context; personaText/memoryText are the same content apart (stable / per-query).
      ...rendered,
      scope,
      world:this.worldStatus()
    };
    // Injection trace: which entries this response carried, by ID and size only. No memory text, no
    // query text, no raw stream or person ID (they hold account numbers). A call that rendered nothing
    // (the executor's pause/epoch probe asks for a 1-character budget) is not an injection.
    if(rendered.text){
      this.traces.push({
        seq:++this.traceSeq,at:this.now(),capabilityId,stream:opaqueStream(capabilityId,input.streamId),person:opaquePerson(scope.personId),owner:scope.personId==='person:owner',audience:scope.audience,
        entityId:e.id,memoryEpoch:result.memoryEpoch,revision:result.revision,personaRevision:result.personaRevision,
        queryChars:query.length,budgetChars:budget,candidates:rows.length,
        chars:{total:rendered.text.length,persona:rendered.personaText.length,memory:rendered.memoryText.length},
        sections
      });
      if(this.traces.length>TRACE_LIMIT)this.traces.shift();
    }
    return result;
  }
  /** Operator-only, read-only: the newest injection traces first, optionally for one person's opaque label. */
  contextTrace(input={}){
    closed(input,['person','limit'],[]);
    this.store.check();
    if(input.person!==undefined&&(typeof input.person!=='string'||!/^p-[0-9a-f]{6}$/.test(input.person)))fail('VALIDATION_ERROR','person must be an opaque person label');
    const limit=integer(input.limit===undefined?50:input.limit,1,TRACE_LIMIT);
    return{
      capacity:TRACE_LIMIT,
      recorded:this.traceSeq,
      traces:this.traces.filter(trace=>input.person===undefined||trace.person===input.person).slice(-limit).reverse()
    };
  }
  health(){
    this.store.check();
    const counts=Object.fromEntries(this.store.db.prepare('SELECT status,COUNT(*) AS count FROM inbox GROUP BY status').all().map(r=>[r.status,r.count])),
    e=this.entity(DEFAULT_ENTITY_ID);
    return{
      revision:this.store.get('revision'),
      personaRevision:e.persona_revision,
      entityId:e.id,
      memoryEpoch:e.memory_epoch,
      pending:counts.pending??0,
      accepted:counts.accepted??0,
      rejected:counts.rejected??0,
      world:this.worldStatus()
    };
  }
  snapshot(){
    this.store.check();
    const e=this.entity(DEFAULT_ENTITY_ID),
    items=this.store.db.prepare('SELECT * FROM memory_items WHERE entity_id=? ORDER BY revision,id').all(e.id).map(r=>this.store.memory(r));
    return{
      ...this.store.get('state'),
      persona:JSON.parse(e.persona),
      personaRevision:e.persona_revision,
      memoryEpoch:e.memory_epoch,
      entityId:e.id,
      entities:this.listEntities(),
      revision:this.store.get('revision'),
      ...Object.fromEntries(['facts','notes','experiences','appraisals'].map(k=>[k,items.filter(i=>i.type===k)])),
      relationships:Object.fromEntries(this.store.db.prepare('SELECT person_id,body FROM relationships WHERE entity_id=?').all(e.id).map(r=>[r.person_id,JSON.parse(r.body)])),
      capabilities:this.store.db.prepare('SELECT * FROM capabilities ORDER BY id').all(),
      actors:this.store.db.prepare('SELECT capability_id AS capabilityId,actor_id AS externalActorId,person_id AS personId FROM actors ORDER BY capability_id,actor_id').all(),
      streams:this.store.db.prepare('SELECT capability_id AS capabilityId,stream_id AS streamId,person_id AS personId,audience,entity_id AS entityId FROM streams ORDER BY capability_id,stream_id').all(),
      observations:this.store.db.prepare('SELECT * FROM observations ORDER BY rowid').all().map(r=>({
        id:r.id,capabilityId:r.capability_id,entityId:r.entity_id,...JSON.parse(r.body),...(r.forgotten?{
          forgotten:true
        }
        :{})
      })),
      receipts:this.store.db.prepare('SELECT capability_id,receipt FROM inbox ORDER BY seq').all().map(r=>({
        capabilityId:r.capability_id,...JSON.parse(r.receipt)
      })),
      audit:this.store.db.prepare('SELECT body FROM audit ORDER BY seq').all().map(r=>JSON.parse(r.body))
    };
  }
  close(){
    this.store.close();
  }
}
function validated(fn){
  try{
    return fn();
  }
  catch(error){
    if(error.code)throw error;
    fail('VALIDATION_ERROR','Invalid bounded persona or payload');
  }
}
