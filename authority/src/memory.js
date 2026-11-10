import { randomUUID, createHash } from 'node:crypto';
import { capability, canonical, closed, contextScope, enumeration, fail, identifier, integer, jsonValue, text } from './identity.js';
import { DEFAULT_ENTITY_ID } from './store.js';
import { normalizePersona, renderPersona } from '../../core/src/persona.js';
import { tokenize } from '../../core/src/util.js';
import { memoryContent, opaquePerson } from './context.js';
import { SENSITIVE } from './policies.js';

const DAY=86400000;
const placeholders=values=>values.map(()=>'?').join(',');
const uniqueIds=ids=>{
  if(!Array.isArray(ids)||!ids.length||ids.length>100)fail('VALIDATION_ERROR','Select 1 to 100 source IDs');
  ids.forEach(identifier);
  return[...new Set(ids)];
};
const publicEntry=entry=>({
  ...entry,evidence:entry.evidence?{
    observationId:entry.evidence.observationId
  }
  :undefined
});
// Operator listing only: where an item came from (which channel, whose words, which kind of proposal).
const PROPOSAL_TYPES={facts:'fact.report',experiences:'experience.remember',appraisals:'appraisal.record'};
const sourceOf=entry=>({
  channel:entry.capabilityId??null,
  role:entry.evidence?.role??null,
  proposal:entry.proposalId?PROPOSAL_TYPES[entry.type]??(entry.kind==='learning'?'learning.note':'self.note'):null
});
export class MemoryDomain {
  entity(id=DEFAULT_ENTITY_ID){
    identifier(id);
    this.store.check();
    const row=this.store.db.prepare('SELECT * FROM entities WHERE id=?').get(id);
    if(!row)fail('NOT_FOUND','Entity not found',404);
    return row;
  }
  getEntity({
    entityId=DEFAULT_ENTITY_ID
  }
  ={}){
    const e=this.entity(entityId);
    return{
      id:e.id,
      entityId:e.id,
      persona:JSON.parse(e.persona),
      personaRevision:e.persona_revision,
      memoryEpoch:e.memory_epoch,
      retentionDays:e.retention_days
    };
  }
  /** Per-stream forget generations, kept in the existing metadata table (no schema change). */
  streamBumps(){
    const row=this.store.db.prepare("SELECT value FROM metadata WHERE key='streamEpochs'").get();
    return row?JSON.parse(row.value):{};
  }
  /** A stream's memory epoch: the entity epoch plus that stream's own scoped-forget count. */
  streamEpoch(entity,capabilityId,streamId){
    return entity.memory_epoch+(this.streamBumps()[entity.id]?.[`${capabilityId}\u0000${streamId}`]??0);
  }
  listEntities(){
    return this.store.db.prepare('SELECT id,persona_revision AS personaRevision,memory_epoch AS memoryEpoch FROM entities ORDER BY id').all();
  }
  createEntity(input){
    closed(input,['id','persona'],['id']);
    identifier(input.id);
    jsonValue(input.persona??{});
    const persona=normalizePersona(input.persona??{});
    return this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM entities WHERE id=?').get(input.id))fail('CONFLICT','Entity exists',409);
      this.store.db.prepare('INSERT INTO entities(id,persona,persona_revision) VALUES(?,?,1)').run(input.id,JSON.stringify(persona));
      this.adminAudit('entity.create',{
        entityId:input.id
      });
      return this.getEntity({
        entityId:input.id
      });
    });
  }
  visibility(scope,policy){
    if(scope.audience==='shared')return{
      sql:"m.visibility='public' AND COALESCE(m.kind,'')!='inner'",
      args:[]
    };
    if(policy==='learning.v1')return{
      sql:"COALESCE(m.kind,'')!='inner' AND m.collection='notes' AND m.kind='learning'",
      args:[]
    };
    return{
      sql:"COALESCE(m.kind,'')!='inner' AND (m.visibility='public' OR m.person_id=? OR (m.collection='notes' AND m.kind='learning'))",
      args:[scope.personId]
    };
  }
  /** `exclude`: memory IDs that are never candidates (already in front of the model).
   * `relevantOnly`: with a query, keep only entries matching at least 2 of its tokens or 15% of them. */
  candidates(scope,policy,query,limit,{ includeArchived = false, exclude = [], relevantOnly = false } = {}){
    const e=this.entity(scope.entityId),
    v=this.visibility(scope,policy),
    tokens=[...new Set(tokenize(query))].slice(0,64),
    now=this.worldStatus().worldNow,
    cutoff=now-e.retention_days*DAY*4;
    if(query.trim()&&!tokens.length)return[];
    const args = [scope.entityId, ...v.args, ...(includeArchived ? [] : [cutoff]), ...exclude];
    const filter = `m.entity_id=? AND ${v.sql} AND m.status='active'
      AND m.collection IN ('facts','notes','experiences')
      ${includeArchived ? '' : 'AND (m.pinned=1 OR m.created_world_at>=?)'}
      ${exclude.length ? `AND m.id NOT IN (${placeholders(exclude)})` : ''}`;
    let rows;
    if(tokens.length)rows=this.store.db.prepare(`SELECT m.*,COUNT(t.token) AS hits FROM memory_items m JOIN memory_tokens t ON t.memory_id=m.id AND t.entity_id=m.entity_id WHERE ${filter} AND t.token IN (${placeholders(tokens)}) GROUP BY m.id ORDER BY hits DESC,m.pinned DESC,m.revision DESC LIMIT ?`).all(...args,...tokens,Math.min(128,limit*4));
    else rows=this.store.db.prepare(`SELECT m.*,0 AS hits FROM memory_items m WHERE ${filter} ORDER BY m.pinned DESC,m.revision DESC LIMIT ?`).all(...args,Math.min(128,limit*4));
    if(relevantOnly&&tokens.length)rows=rows.filter(row=>row.hits>=2||row.hits/tokens.length>=0.15);
    const ranked=rows.map(row=>({
      row,score:(tokens.length?row.hits/tokens.length:1)+(row.pinned?2:0)+row.importance*Math.pow(0.5,Math.max(0,now-row.created_world_at)/(e.retention_days*DAY))
    })).sort((a,b)=>b.score-a.score||b.row.revision-a.row.revision).slice(0,limit);
    return ranked.map(({
      row
    })=>{
      const entry = { ...this.store.memory(row), archived: !row.pinned && row.created_world_at < cutoff };
      return row.visibility==='public'?publicEntry(entry):entry;
    });
  }
  /** The facts of the person this private conversation is with, for their standing profile: pinned
   * first, then by importance, newest first. The order never depends on a query or on the time. */
  profileEntries(scope,policy){
    if(scope.audience!=='private'||policy!=='conversation.v1')return[];
    const e=this.entity(scope.entityId),
    v=this.visibility(scope,policy),
    cutoff=this.worldStatus().worldNow-e.retention_days*DAY*4;
    return this.store.db.prepare(`SELECT m.* FROM memory_items m WHERE m.entity_id=? AND ${v.sql} AND m.status='active'
      AND m.collection='facts' AND m.person_id=? AND (m.pinned=1 OR m.created_world_at>=?)
      ORDER BY m.pinned DESC,m.importance DESC,m.revision DESC,m.id LIMIT 64`).all(scope.entityId,...v.args,scope.personId,cutoff).map(row=>{
      const entry=this.store.memory(row);
      return row.visibility==='public'?publicEntry(entry):entry;
    });
  }
  memorySearch(capabilityId,input){
    closed(input,['streamId','query','limit','budgetChars'],['streamId','query']);
    const policy=capability(this.store,capabilityId).policy,
    scope=contextScope(this.store,capabilityId,input.streamId),
    e=this.entity(scope.entityId);
    text(input.query,2000,true);
    const limit=integer(input.limit??8,1,32),
    budget=integer(input.budgetChars??2400,0,16000),
    rows=this.candidates(scope,policy,input.query,limit,{ includeArchived: true });
    let remaining=budget;
    const items=[];
    for(const row of rows){
      const content=memoryContent(row),
      excerpt=content.slice(0,Math.min(remaining,1000));
      if(!excerpt)continue;
      items.push({
        id:row.id,type:row.type,excerpt,importance:row.importance,pinned:row.pinned,archived:row.archived,revision:row.revision
      });
      remaining-=excerpt.length;
    }
    return{
      entityId:e.id,
      memoryEpoch:this.streamEpoch(e,capabilityId,scope.streamId),
      items,
      text:items.map(i=>JSON.stringify({
        id:i.id,text:i.excerpt
      })).join('\n').slice(0,budget),
      world:this.worldStatus()
    };
  }
  memoryRead(capabilityId,input){
    closed(input,['streamId','id']);
    identifier(input.id);
    const policy=capability(this.store,capabilityId).policy,
    scope=contextScope(this.store,capabilityId,input.streamId),
    e=this.entity(scope.entityId),
    v=this.visibility(scope,policy),
    cutoff=this.worldStatus().worldNow-e.retention_days*DAY*4;
    const row=this.store.db.prepare(`SELECT m.* FROM memory_items m WHERE m.id=? AND m.entity_id=? AND ${v.sql} AND m.status='active' AND m.collection IN ('facts','notes','experiences')`).get(input.id,e.id,...v.args);
    const memory = row ? this.store.memory(row) : null;
    // Model-facing read: the person is an opaque label, never a raw person ID.
    const item = memory ? { ...memory, ...(memory.personId ? { personId: opaquePerson(memory.personId) } : {}), archived: !row.pinned && row.created_world_at < cutoff } : null;
    return{
      entityId:e.id,
      memoryEpoch:this.streamEpoch(e,capabilityId,scope.streamId),
      item: item && row.visibility === 'public' ? publicEntry(item) : item
    };
  }
  /** Operator listing, newest revision first. `beforeRevision` pages back (`more` says whether older
   * items remain); `person` keeps one owner: an opaque person label, or 'none' for items nobody owns.
   * Diaries belong to no person and are only listed without that filter. */
  listMemory(input={}){
    closed(input,['entityId','limit','beforeRevision','includeArchived','person'],[]);
    const e=this.entity(input.entityId??DEFAULT_ENTITY_ID),
    limit=integer(input.limit??50,1,100),
    before=integer(input.beforeRevision??Number.MAX_SAFE_INTEGER),
    now=this.worldStatus().worldNow;
    if(input.person!==undefined&&(typeof input.person!=='string'||!/^(p-[0-9a-f]{6}|none)$/.test(input.person)))fail('VALIDATION_ERROR','person must be an opaque person label or none');
    const owners=this.store.db.prepare('SELECT person_id AS personId,COUNT(*) AS items FROM memory_items WHERE entity_id=? GROUP BY person_id').all(e.id),
    wanted=owners.filter(o=>o.personId!==null&&opaquePerson(o.personId)===input.person).map(o=>o.personId),
    scope=input.person===undefined?'':input.person==='none'?' AND person_id IS NULL':wanted.length?` AND person_id IN (${placeholders(wanted)})`:' AND 0';
    const found=this.store.db.prepare(`SELECT * FROM memory_items WHERE entity_id=? AND revision<?${scope} ORDER BY revision DESC,id LIMIT ?`).all(e.id,before,...wanted,limit+1),
    rows=found.slice(0,limit);
    const entries=rows.map(r=>{
      const entry=this.store.memory(r);
      return{
        ...entry,archived:r.status==='active'&&!r.pinned&&now-r.created_world_at>e.retention_days*DAY*4,
        // For display: the same opaque label the people listing uses, never an account number.
        personLabel:r.person_id?opaquePerson(r.person_id):null,personIsOwner:r.person_id==='person:owner',source:sourceOf(entry)
      };
    }).filter(r=>input.includeArchived!==false||(!r.archived&&r.status==='active'));
    const diaries=input.person!==undefined?[]:this.store.db.prepare('SELECT * FROM diaries WHERE entity_id=? AND revision<? ORDER BY revision DESC LIMIT ?').all(e.id,before,limit).map(r=>({
      id:r.id,type:'diary',kind:r.kind,status:r.status,revision:r.revision,entityId:e.id,...JSON.parse(r.body)
    }));
    return{
      entityId:e.id,
      memoryEpoch:e.memory_epoch,
      items:entries,
      diaries,
      more:found.length>limit,
      // Who owns items at all (for a filter), with item counts.
      people:owners.filter(o=>o.personId!==null).map(o=>({label:opaquePerson(o.personId),owner:o.personId==='person:owner',items:o.items})).sort((a,b)=>b.owner-a.owner||(a.label<b.label?-1:1)),
      unowned:owners.find(o=>o.personId===null)?.items??0
    };
  }
  setMemoryRetention(input) {
    closed(input, ['entityId', 'id', 'importance', 'pinned', 'eventAt'], ['entityId', 'id']);
    identifier(input.id);
    if (input.importance !== undefined && (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)) fail('VALIDATION_ERROR', 'Importance must be in 0..1');
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') fail('VALIDATION_ERROR', 'pinned must be boolean');
    if (input.eventAt !== undefined && input.eventAt !== null) integer(input.eventAt);
    return this.store.transaction(() => {
      this.entity(input.entityId);
      const row = this.store.db.prepare('SELECT * FROM memory_items WHERE entity_id=? AND id=?').get(input.entityId, input.id);
      if (!row) fail('NOT_FOUND', 'Memory not found', 404);
      const body = JSON.parse(row.body);
      if (Object.hasOwn(input, 'eventAt')) body.eventAt = input.eventAt;
      const importance = input.importance ?? row.importance, pinned = input.pinned === undefined ? row.pinned : Number(input.pinned);
      this.store.db.prepare('UPDATE memory_items SET importance=?,pinned=?,revision=?,body=? WHERE id=?')
        .run(importance, pinned, this.store.nextRevision(), JSON.stringify(body), row.id);
      this.store.audit({ type: 'memory.retention', entityId: input.entityId, id: input.id, importance, pinned: Boolean(pinned), eventAt: body.eventAt ?? null, at: this.now() });
      return this.store.memory(this.store.db.prepare('SELECT * FROM memory_items WHERE id=?').get(row.id));
    });
  }
  markMemoryPublic(input){
    closed(input,['entityId','id']);
    return this.store.transaction(()=>{
      this.entity(input.entityId);
      const row=this.store.db.prepare('SELECT * FROM memory_items WHERE entity_id=? AND id=?').get(input.entityId,input.id);
      if(!row||row.kind==='inner'||row.collection==='appraisals')fail('FORBIDDEN','Not a public material',403);
      if(SENSITIVE.test(memoryContent(JSON.parse(row.body))))fail('FORBIDDEN','Sensitive material requires a separate explicit process',403);
      const body={
        ...JSON.parse(row.body),visibility:'public'
      };
      this.store.db.prepare("UPDATE memory_items SET visibility='public',body=?,revision=? WHERE id=?").run(JSON.stringify(body),this.store.nextRevision(),row.id);
      this.store.audit({
        type:'memory.public-authorized',entityId:input.entityId,id:input.id,at:this.now()
      });
      return publicEntry(this.store.memory(this.store.db.prepare('SELECT * FROM memory_items WHERE id=?').get(row.id)));
    });
  }
  writePrivateDiary(input){
    closed(input,['entityId','text','sourceIds'],['entityId','text']);
    text(input.text,4000);
    const ids=input.sourceIds?.length?uniqueIds(input.sourceIds):[];
    return this.store.transaction(()=>this.saveDiary(input.entityId,'private',input.text,ids));
  }
  savePublicDiaryDraft(input){
    closed(input,['entityId','text','sourceIds']);
    text(input.text,4000);
    const ids=uniqueIds(input.sourceIds);
    return this.store.transaction(()=>this.saveDiary(input.entityId,'public',input.text,ids));
  }
  saveDiary(entityId,kind,body,sourceIds){
    this.entity(entityId);
    for(const id of sourceIds){
      const item=this.store.db.prepare('SELECT * FROM memory_items WHERE entity_id=? AND id=?').get(entityId,id);
      if(!item||item.status!=='active'||(kind==='public'&&(item.visibility!=='public'||item.kind==='inner')))fail('FORBIDDEN','Diary sources unavailable',403);
    }
    const id=randomUUID(),
    revision=this.store.nextRevision();
    this.store.db.prepare('INSERT INTO diaries(id,entity_id,kind,status,revision,world_at,body) VALUES(?,?,?,?,?,?,?)').run(id,entityId,kind,kind==='public'?'draft':'private',revision,this.worldStatus().worldNow,JSON.stringify({
      text:body
    }));
    for(const sourceId of sourceIds)this.store.db.prepare('INSERT INTO diary_sources(diary_id,memory_id) VALUES(?,?)').run(id,sourceId);
    this.store.audit({
      type:'diary.saved',entityId,id,kind,revision,sourceIds,at:this.now()
    });
    return{
      id,
      status:kind==='public'?'draft':'private',
      revision,
      sourceIds
    };
  }
  publishDiary(input){
    closed(input,['entityId','id']);
    return this.store.transaction(()=>{
      this.entity(input.entityId);
      const row=this.store.db.prepare("SELECT * FROM diaries WHERE entity_id=? AND id=? AND kind='public'").get(input.entityId,input.id);
      if(!row)fail('NOT_FOUND','Public draft not found',404);
      const revision=this.store.nextRevision();
      this.store.db.prepare("UPDATE diaries SET status='published',revision=? WHERE id=?").run(revision,row.id);
      this.store.audit({
        type:'diary.published',entityId:input.entityId,id:row.id,revision,at:this.now()
      });
      return{
        id:row.id,status:'published',revision
      };
    });
  }
  maintenanceBatch(entityId,input={}){
    closed(input,['afterRevision','limit','mode'],[]);
    const e=this.entity(entityId),
    world=this.worldStatus(),
    mode=enumeration(input.mode??'private',['private','public']),
    after=integer(input.afterRevision??0),
    limit=integer(input.limit??8,1,16);
    if(world.paused)return{
      entityId:e.id,
      memoryEpoch:e.memory_epoch,
      cursor:after,
      items:[],
      personaText:'',
      world
    };
    const rows=this.store.db.prepare(`SELECT * FROM memory_items WHERE entity_id=? AND revision>? AND collection IN ('facts','notes','experiences') ORDER BY revision,id LIMIT ?`).all(e.id,after,limit),
    latest=this.store.db.prepare('SELECT MAX(revision) AS revision FROM diaries WHERE entity_id=?').get(e.id).revision??after;
    const cursor=rows.length?rows.at(-1).revision:Math.max(after,latest);
    let remaining=6000;
    const items=rows.filter(r=>r.status==='active'&&(mode!=='public'||(r.visibility==='public'&&r.kind!=='inner'))).map(r=>{
      const m=this.store.memory(r),content=memoryContent(m);
      if(SENSITIVE.test(content)||remaining<=0)return null;
      const bounded=content.slice(0,Math.min(remaining,2000));
      remaining-=bounded.length;
      return{
        id:r.id,type:r.collection,text:bounded,importance:r.importance,pinned:Boolean(r.pinned),visibility:r.visibility,...(mode==='private'?{
          personId:m.personId
        }
        :{}),at:m.at
      };
    }).filter(Boolean);
    const taskId=createHash('sha256').update(canonical({
      entityId:e.id,after,cursor,epoch:e.memory_epoch,mode,ids:items.map(i=>i.id),worldRevision:world.revision
    })).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO maintenance_tasks(id,entity_id,epoch,cursor,world_revision,mode,source_ids) VALUES(?,?,?,?,?,?,?)').run(taskId,e.id,e.memory_epoch,cursor,world.revision,mode,JSON.stringify(items.map(i=>i.id)));
    // Core may have committed before the Host persisted its cursor. Re-admitting
    // that same batch must not ask the model to regenerate an already saved diary.
    const committedReceipt = this.store.db.prepare(`SELECT d.id,d.status,d.revision
      FROM diary_receipts r JOIN diaries d ON d.id=r.diary_id
      WHERE r.task_id=? AND r.kind=? AND d.entity_id=?`).get(taskId, mode, e.id);
    return{
      entityId:e.id,
      taskId,
      memoryEpoch:e.memory_epoch,
      cursor,
      items: committedReceipt ? [] : items,
      ...(committedReceipt ? { committedReceipt } : {}),
      personaText:renderPersona({
        ...JSON.parse(e.persona),userCallName:'你',relationshipStage:'new'
      }).slice(0,1000),
      world
    };
  }
  maintenanceDiary(entityId,input){
    closed(input,['taskId','kind','text','sourceIds']);
    identifier(input.taskId);
    enumeration(input.kind,['private','public']);
    text(input.text,4000);
    if(SENSITIVE.test(input.text))fail('FORBIDDEN','Sensitive automatic diary denied',403);
    const ids=uniqueIds(input.sourceIds);
    return this.store.transaction(()=>{
      const e=this.entity(entityId),world=this.worldStatus(),task=this.store.db.prepare('SELECT * FROM maintenance_tasks WHERE id=? AND entity_id=?').get(input.taskId,e.id);
      if(!task||task.mode!==input.kind||task.epoch!==e.memory_epoch||task.world_revision!==world.revision||world.paused)fail('CONFLICT','Maintenance batch is no longer current',409);
      const allowed=new Set(JSON.parse(task.source_ids));
      if(ids.some(id=>!allowed.has(id)))fail('FORBIDDEN','Sources outside admitted batch',403);
      const encoding=canonical(input),old=this.store.db.prepare('SELECT * FROM diary_receipts WHERE task_id=? AND kind=?').get(task.id,input.kind);
      if(old){
        if(old.canonical!==encoding)fail('CONFLICT','Diary retry changed content',409);
        const row=this.store.db.prepare('SELECT * FROM diaries WHERE id=?').get(old.diary_id);
        return{
          entityId:e.id,memoryEpoch:e.memory_epoch,cursor:task.cursor,receipt:{
            id:row.id,status:row.status,revision:row.revision
          },sourceIds:ids
        };
      }
      const receipt=this.saveDiary(e.id,input.kind,input.text,ids);
      this.store.db.prepare('INSERT INTO diary_receipts(task_id,kind,diary_id,canonical) VALUES(?,?,?,?)').run(task.id,input.kind,receipt.id,encoding);
      return{
        entityId:e.id,memoryEpoch:e.memory_epoch,cursor:task.cursor,receipt,sourceIds:ids
      };
    });
  }
  forgetPreview(input){
    closed(input,['entityId','ids']);
    const e=this.entity(input.entityId),
    selected=uniqueIds(input.ids),
    memoryIds=new Set(),
    diaryIds=new Set(),
    sources=new Set();
    for(const id of selected){
      if(this.store.db.prepare('SELECT id FROM memory_items WHERE entity_id=? AND id=?').get(e.id,id))memoryIds.add(id);
      else if(this.store.db.prepare('SELECT id FROM diaries WHERE entity_id=? AND id=?').get(e.id,id))diaryIds.add(id);
      else if(this.store.db.prepare('SELECT id FROM observations WHERE entity_id=? AND id=? AND forgotten=0').get(e.id,id))sources.add(id);
      else fail('NOT_FOUND','Selected memory or source not found',404);
    }
    let changed=true;
    while(changed){
      const n=memoryIds.size+sources.size+diaryIds.size;
      for(const id of memoryIds)for(const r of this.store.db.prepare('SELECT observation_id FROM memory_sources WHERE memory_id=?').all(id))sources.add(r.observation_id);
      for(const source of sources)for(const r of this.store.db.prepare('SELECT m.id FROM memory_items m JOIN memory_sources s ON s.memory_id=m.id WHERE m.entity_id=? AND s.observation_id=?').all(e.id,source))memoryIds.add(r.id);
      for(const id of memoryIds)for(const r of this.store.db.prepare('SELECT d.id FROM diaries d JOIN diary_sources s ON s.diary_id=d.id WHERE d.entity_id=? AND s.memory_id=?').all(e.id,id))diaryIds.add(r.id);
      changed=n!==memoryIds.size+sources.size+diaryIds.size;
    }
    const sourceEvents=[...sources].map(id=>this.store.db.prepare('SELECT capability_id AS capabilityId,stream_id AS streamId,event_id AS eventId FROM observations WHERE id=?').get(id));
    // Scope: a person-private memory could only have reached that person's own
    // conversations (and its source streams). Public/unowned material, or a
    // selection with no bound stream, retires every conversation (entity epoch).
    const allStreams=this.store.db.prepare('SELECT capability_id AS capabilityId,stream_id AS streamId,person_id AS personId FROM streams WHERE entity_id=? ORDER BY capability_id,stream_id').all(e.id);
    let entityWide=false;
    const people=new Set();
    for(const id of memoryIds){
      const row=this.store.db.prepare('SELECT person_id,visibility FROM memory_items WHERE id=?').get(id);
      if(!row.person_id||row.visibility==='public')entityWide=true;
      else people.add(row.person_id);
    }
    const sourceStreams=new Set(sourceEvents.map(event=>`${event.capabilityId}\u0000${event.streamId}`));
    const scoped=allStreams.filter(stream=>people.has(stream.personId)||sourceStreams.has(`${stream.capabilityId}\u0000${stream.streamId}`));
    if(!scoped.length)entityWide=true;
    return{
      entityId:e.id,
      memoryEpoch:e.memory_epoch,
      revision:this.store.get('revision'),
      ids:selected,
      expandedIds:[...memoryIds,
      ...diaryIds],
      memoryIds:[...memoryIds],
      diaryIds:[...diaryIds],
      sourceObservationIds:[...sources],
      sourceEvents,
      affectedStreams:(entityWide?allStreams:scoped).map(({capabilityId,streamId})=>({capabilityId,streamId})),
      epochScope:entityWide?'entity':'streams',
      externalCleanupRequired:true
    };
  }
  forgetApply(input){
    closed(input,['entityId','ids','expectedMemoryEpoch','expectedRevision'],['entityId','ids','expectedMemoryEpoch']);
    integer(input.expectedMemoryEpoch);
    return this.store.transaction(()=>{
      if(!this.worldStatus().paused)fail('CONFLICT','Pause the world before forgetting',409);
      const preview=this.forgetPreview({
        entityId:input.entityId,ids:input.ids
      });
      if(preview.memoryEpoch!==input.expectedMemoryEpoch||(input.expectedRevision!==undefined&&preview.revision!==input.expectedRevision))fail('CONFLICT','Forget preview is stale',409);
       const people=new Set();
      for(const id of preview.memoryIds){
        const row=this.store.db.prepare('SELECT person_id FROM memory_items WHERE id=?').get(id);
        if(row?.person_id)people.add(row.person_id);
        this.store.db.prepare('DELETE FROM memory_items WHERE id=? AND entity_id=?').run(id,input.entityId);
      }
      for(const id of preview.diaryIds){
        this.store.db.prepare('DELETE FROM diary_receipts WHERE diary_id=?').run(id);
        this.store.db.prepare('DELETE FROM diaries WHERE id=? AND entity_id=?').run(id,input.entityId);
      }
      for(const id of preview.sourceObservationIds){
        const row=this.store.db.prepare('SELECT * FROM observations WHERE id=? AND entity_id=?').get(id,input.entityId);
        if(!row)continue;
        this.store.db.prepare('INSERT OR IGNORE INTO source_tombstones(entity_id,capability_id,stream_id,event_id,observation_id) VALUES(?,?,?,?,?)').run(input.entityId,row.capability_id,row.stream_id,row.event_id,id);
        const metadata=JSON.parse(row.body);
        metadata.text='';
        this.store.db.prepare("UPDATE observations SET canonical='',body=?,forgotten=1 WHERE id=?").run(JSON.stringify(metadata),id);
        this.store.db.prepare("UPDATE inbox SET body='{}',canonical='',forgotten=1,status=CASE WHEN status='pending' THEN 'rejected' ELSE status END,receipt=CASE WHEN status='pending' THEN json_set(receipt,'$.status','rejected','$.reason','source_forgotten') ELSE receipt END WHERE observation_id=?").run(id);
         for(const audit of this.store.db.prepare("SELECT seq,body FROM audit WHERE json_extract(body,'$.observationId')=?").all(id)){
          const old=JSON.parse(audit.body);
          this.store.db.prepare('UPDATE audit SET body=? WHERE seq=?').run(JSON.stringify({
            type:old.type,entityId:input.entityId,proposalId:old.proposalId,observationId:id,status:old.status,revision:old.revision,at:old.at,contentErased:true
          }),audit.seq);
        }
      }
      for(const person of people){
        const score=this.store.db.prepare("SELECT COALESCE(SUM(json_extract(body,'$.delta')),0) AS score FROM memory_items WHERE entity_id=? AND person_id=? AND collection='appraisals'").get(input.entityId,person).score;
        this.store.db.prepare('UPDATE relationships SET body=? WHERE entity_id=? AND person_id=?').run(JSON.stringify({
          score:Math.min(100,score)
        }),input.entityId,person);
      }
      this.store.db.prepare('DELETE FROM maintenance_tasks WHERE entity_id=?').run(input.entityId);
      // Entity-wide: bump the entity epoch (every conversation restarts). Scoped:
      // bump only the affected streams, so other people's sessions survive.
      if(preview.epochScope==='entity')this.store.db.prepare('UPDATE entities SET memory_epoch=? WHERE id=?').run(preview.memoryEpoch+1,input.entityId);
      else{
        const bumps=this.streamBumps(),own=bumps[input.entityId]||={};
        for(const stream of preview.affectedStreams){
          const key=`${stream.capabilityId}\u0000${stream.streamId}`;
          own[key]=(own[key]??0)+1;
        }
        this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('streamEpochs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(bumps));
      }
      const entity=this.entity(input.entityId),
      affectedStreams=preview.affectedStreams.map(stream=>({...stream,memoryEpoch:this.streamEpoch(entity,stream.capabilityId,stream.streamId)})),
      epoch=preview.epochScope==='entity'?entity.memory_epoch:Math.max(...affectedStreams.map(stream=>stream.memoryEpoch));
      const id=randomUUID(),job={
        id,entityId:input.entityId,memoryEpoch:epoch,epochScope:preview.epochScope,affectedStreams,sourceObservationIds:preview.sourceObservationIds,sourceEvents:preview.sourceEvents
      };
      this.store.db.prepare('INSERT INTO cleanup_jobs(id,entity_id,epoch,status,body) VALUES(?,?,?,?,?)').run(id,input.entityId,epoch,'pending',JSON.stringify(job));
      this.store.audit({
        type:'memory.forgotten',entityId:input.entityId,ids:preview.expandedIds,memoryEpoch:epoch,epochScope:preview.epochScope,revision:this.store.nextRevision(),at:this.now()
      });
      return{
        ...job,coreErased:true,externalCleanup:{
          status:'pending',id
        },complete:false
      };
    });
  }
  cleanupPending(){
    return this.store.db.prepare("SELECT body FROM cleanup_jobs WHERE status='pending' ORDER BY rowid").all().map(r=>JSON.parse(r.body));
  }
  cleanupComplete(input){
    closed(input,['id','memoryEpoch','report']);
    integer(input.memoryEpoch);
    closed(input.report,['sdkPurged','localSourcesPurged','platform']);
    if(input.report.sdkPurged!==true||input.report.localSourcesPurged!==true||input.report.platform!=='outside-control')fail('CONFLICT','Controlled external erasure is not complete',409);
    return this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM cleanup_jobs WHERE id=?').get(input.id);
      if(!row||row.epoch!==input.memoryEpoch)fail('CONFLICT','Cleanup generation conflicts',409);
      this.store.db.prepare("UPDATE cleanup_jobs SET status='complete' WHERE id=?").run(row.id);
      this.store.audit({
        type:'memory.external-cleanup',entityId:row.entity_id,id:row.id,memoryEpoch:row.epoch,report:input.report,revision:this.store.nextRevision(),at:this.now()
      });
      return{
        id:row.id,status:'complete',controlledDataErased:true,platform:'outside-control'
      };
    });
  }
  /** Date recall: pinned items, important facts (>=0.8) and experiences from their default importance (0.65) up. */
  memoryRecall(capabilityId, input) {
    closed(input, ['streamId', 'fromAt', 'toAt', 'limit', 'budgetChars'], ['streamId', 'fromAt', 'toAt']);
    const policy = capability(this.store, capabilityId).policy;
    const scope = contextScope(this.store, capabilityId, input.streamId);
    const entity = this.entity(scope.entityId),
    visible = this.visibility(scope, policy);
    integer(input.fromAt);
    integer(input.toAt, input.fromAt);
    const limit = integer(input.limit ?? 8, 1, 16),
    budget = integer(input.budgetChars ?? 2400, 0, 16000);
    const rows = this.store.db.prepare(`SELECT m.* FROM memory_items m
      WHERE m.entity_id=? AND ${visible.sql} AND m.status='active'
      AND m.collection IN ('facts','experiences') AND (m.pinned=1 OR m.importance>=0.8 OR (m.collection='experiences' AND m.importance>=0.65))
      AND COALESCE(json_extract(m.body,'$.eventAt'),json_extract(m.body,'$.evidence.at'),m.created_world_at) BETWEEN ? AND ?
      ORDER BY m.pinned DESC,m.importance DESC,m.revision DESC LIMIT ?`) .all(entity.id, ...visible.args, input.fromAt, input.toAt, limit);
    let remaining = budget;
    const items = rows.map(row => {
      const memory = this.store.memory(row), content = memoryContent(memory).slice(0, Math.min(1000, remaining));
       remaining -= content.length;
       return {
        id: row.id, text: content, recordedAt: memory.recordedAt, eventAt: memory.eventAt, dateBasis: memory.eventAt === null ? 'recordedAt' : 'eventAt', importance: row.importance, pinned: Boolean(row.pinned)
      };
    }).filter(item => item.text);
    return {
      entityId: entity.id,
      memoryEpoch: this.streamEpoch(entity, capabilityId, scope.streamId),
      items,
      kind: 'recall',
      isNewEvidence: false
    };
  }
  memoryStatus(){
    return{
      world:this.worldStatus(),
      entities:this.listEntities(),
      pendingExternalCleanup:this.cleanupPending().length
    };
  }
}
