import { DatabaseSync } from 'node:sqlite';
import { AuthorityError, fail } from './identity.js';
import { tokenize } from '../../core/src/util.js';
import { MIGRATIONS, migrate } from './migrations.js';
export const APPLICATION_ID = 0x42464641;
export const SCHEMA_VERSION = 2;
export const DEFAULT_ENTITY_ID = 'entity:big-fat-fish';
const V1 = {
  metadata:['key',
  'value'],
  capabilities:['id',
  'policy'],
  actors:['capability_id',
  'actor_id',
  'person_id'],
  streams:['capability_id',
  'stream_id',
  'person_id',
  'audience'],
  observations:['id',
  'capability_id',
  'stream_id',
  'event_id',
  'canonical',
  'body'],
  inbox:['seq',
  'capability_id',
  'proposal_id',
  'observation_id',
  'canonical',
  'body',
  'policy',
  'status',
  'receipt'],
  audit:['seq',
  'body']
};
/** user_version stays 2: later schema changes are additive entries in migrations.js, which the
 * release being replaced must still be able to open. v2 tolerates unknown tables and columns. */
export function inspect(db) {
  const app=db.prepare('PRAGMA application_id').get().application_id,
  version=db.prepare('PRAGMA user_version').get().user_version;
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name);
  if(!app&&!version&&!tables.length)return 0;
  if(app!==APPLICATION_ID||![1,2].includes(version))fail('SCHEMA_ERROR','Foreign or unsupported authority database',409);
  if(version===1){
    if(tables.some(n=>!Object.hasOwn(V1,n)&&n!=='sqlite_sequence'))fail('SCHEMA_ERROR','Unexpected authority schema',409);
    for(const [name,columns] of Object.entries(V1))if(JSON.stringify(db.prepare(`PRAGMA table_info(${name})`).all().map(r=>r.name))!==JSON.stringify(columns))fail('SCHEMA_ERROR','Incomplete authority v1 schema',409);
    try{
      const s=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='state'").get().value);
      if(!s.persona||!s.relationships||['facts','notes','experiences','appraisals'].some(k=>!Array.isArray(s[k])))throw Error();
    }
    catch{
      fail('SCHEMA_ERROR','Invalid v1 state',409);
    }
  }
  else if(['entities','memory_items','memory_tokens','memory_sources','relationships','diaries','diary_sources','source_tombstones','maintenance_tasks','diary_receipts','cleanup_jobs'].some(t=>!tables.includes(t)))fail('SCHEMA_ERROR','Incomplete authority v2 schema',409);
  return version;
}
/** SQLite retains the EXCLUSIVE writer lease, including through schema migration. */
export class Store {
  constructor(file,initialState,options={}){
    this.closed=false;
    try{
      this.db=new DatabaseSync(file);
      this.db.exec('PRAGMA busy_timeout=0');
      const version=inspect(this.db);
      if(!['delete','memory'].includes(this.db.prepare('PRAGMA journal_mode').get().journal_mode))fail('SCHEMA_ERROR','Unsupported journal mode',409);
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN EXCLUSIVE');
      try{
        if(inspect(this.db)!==version)fail('SCHEMA_ERROR','Database changed during initialization',409);
        if(!version){
          this.db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE capabilities(id TEXT PRIMARY KEY,policy TEXT NOT NULL);
          CREATE TABLE actors(capability_id TEXT NOT NULL REFERENCES capabilities(id),actor_id TEXT NOT NULL,person_id TEXT NOT NULL,PRIMARY KEY(capability_id,actor_id));
          CREATE TABLE streams(capability_id TEXT NOT NULL REFERENCES capabilities(id),stream_id TEXT NOT NULL,person_id TEXT NOT NULL,audience TEXT NOT NULL,PRIMARY KEY(capability_id,stream_id));
          CREATE TABLE observations(id TEXT PRIMARY KEY,capability_id TEXT NOT NULL REFERENCES capabilities(id),stream_id TEXT NOT NULL,event_id TEXT NOT NULL,canonical TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(capability_id,stream_id,event_id));
          CREATE TABLE inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,capability_id TEXT NOT NULL REFERENCES capabilities(id),proposal_id TEXT NOT NULL,observation_id TEXT NOT NULL REFERENCES observations(id),canonical TEXT NOT NULL,body TEXT NOT NULL,policy TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(capability_id,proposal_id));
          CREATE INDEX inbox_pending ON inbox(status,seq); CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);`);
          this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('state',JSON.stringify(initialState));
          this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('revision','0');
        }
        if(version<2)this.migrateV1();
        this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2; COMMIT`);
      }
      catch(error){
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.migrated=migrate(this.db,file,options.migrations??MIGRATIONS,{
        fresh:!version,...(options.now?{now:options.now}:{})
      });
    }
    catch(error){
      try{
        this.db?.close();
      }
      catch{}
      if(error.errcode===5||error.errcode===6||/database is locked|database table is locked/i.test(error.message))throw new AuthorityError('WRITER_BUSY','Authority database already has a writer',409);
      throw error;
    }
  }
  migrateV1(){
    const state=this.get('state');
    this.db.exec(`CREATE TABLE entities(id TEXT PRIMARY KEY,persona TEXT NOT NULL,persona_revision INTEGER NOT NULL,memory_epoch INTEGER NOT NULL DEFAULT 0,retention_days INTEGER NOT NULL DEFAULT 90);
    CREATE TABLE memory_items(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id),collection TEXT NOT NULL,person_id TEXT,visibility TEXT NOT NULL,kind TEXT,status TEXT NOT NULL,importance REAL NOT NULL,pinned INTEGER NOT NULL,created_world_at INTEGER NOT NULL,revision INTEGER NOT NULL,superseded_by TEXT,body TEXT NOT NULL);
    CREATE INDEX memory_scope ON memory_items(entity_id,status,visibility,person_id,revision); CREATE INDEX memory_changes ON memory_items(entity_id,revision);
    CREATE INDEX fact_key ON memory_items(entity_id,person_id,json_extract(body,'$.key'),status);
    CREATE INDEX memory_dates ON memory_items(entity_id,collection,COALESCE(json_extract(body,'$.eventAt'),json_extract(body,'$.evidence.at'),created_world_at));
    CREATE TABLE memory_tokens(entity_id TEXT NOT NULL,token TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,PRIMARY KEY(entity_id,token,memory_id));
    CREATE TABLE memory_sources(memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,observation_id TEXT NOT NULL REFERENCES observations(id),PRIMARY KEY(memory_id,observation_id));
    CREATE INDEX source_memory ON memory_sources(observation_id,memory_id);
    CREATE TABLE relationships(entity_id TEXT NOT NULL REFERENCES entities(id),person_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(entity_id,person_id));
    CREATE TABLE diaries(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id),kind TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,world_at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX diary_changes ON diaries(entity_id,revision);
    CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,epoch INTEGER NOT NULL,cursor INTEGER NOT NULL,world_revision INTEGER NOT NULL,mode TEXT NOT NULL,source_ids TEXT NOT NULL);
    CREATE TABLE diary_receipts(task_id TEXT NOT NULL,kind TEXT NOT NULL,diary_id TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(task_id,kind));
    CREATE TABLE cleanup_jobs(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE diary_sources(diary_id TEXT NOT NULL REFERENCES diaries(id) ON DELETE CASCADE,memory_id TEXT NOT NULL,PRIMARY KEY(diary_id,memory_id));
    CREATE TABLE source_tombstones(entity_id TEXT NOT NULL,capability_id TEXT NOT NULL,stream_id TEXT NOT NULL,event_id TEXT NOT NULL,observation_id TEXT NOT NULL,PRIMARY KEY(entity_id,capability_id,stream_id,event_id));
    ALTER TABLE streams ADD COLUMN entity_id TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}';
    ALTER TABLE observations ADD COLUMN entity_id TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}'; ALTER TABLE observations ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE inbox ADD COLUMN entity_id TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}'; ALTER TABLE inbox ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0;`);
    this.db.prepare('INSERT INTO entities(id,persona,persona_revision) VALUES(?,?,?)').run(DEFAULT_ENTITY_ID,JSON.stringify(state.persona),state.personaRevision);
    for(const collection of ['facts','experiences','notes','appraisals'])for(const entry of state[collection])this.insertMemory(DEFAULT_ENTITY_ID,collection,entry,state.world?.anchorWorldAt??0);
    for(const [personId,relationship]of Object.entries(state.relationships))this.db.prepare('INSERT INTO relationships(entity_id,person_id,body) VALUES(?,?,?)').run(DEFAULT_ENTITY_ID,personId,JSON.stringify(relationship));
    this.set('state',{
      world:state.world
    });
  }
  insertMemory(entityId,collection,entry,worldAt,options={}){
    const importance=options.importance??(collection==='facts'?0.8:collection==='experiences'?0.65:0.45);
    this.db.prepare('INSERT INTO memory_items(id,entity_id,collection,person_id,visibility,kind,status,importance,pinned,created_world_at,revision,superseded_by,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.id,entityId,collection,entry.personId??null,entry.visibility??'private',entry.kind??null,options.status??'active',importance,options.pinned?1:0,worldAt,entry.revision,null,JSON.stringify(entry));
    const content=[entry.key,
    entry.value,
    entry.summary,
    entry.text].filter(v=>typeof v==='string').join(' '),
    insert=this.db.prepare('INSERT OR IGNORE INTO memory_tokens(entity_id,token,memory_id) VALUES(?,?,?)');
    for(const token of new Set(tokenize(content)))insert.run(entityId,token,entry.id);
    if(entry.evidence?.observationId&&this.db.prepare('SELECT id FROM observations WHERE id=?').get(entry.evidence.observationId))this.db.prepare('INSERT INTO memory_sources(memory_id,observation_id) VALUES(?,?)').run(entry.id,entry.evidence.observationId);
  }
  memory(row){
    const entry = JSON.parse(row.body);
    return{
      ...entry,
      eventAt: entry.eventAt ?? null,
      recordedAt: entry.evidence?.at ?? entry.at ?? row.created_world_at,
      entityId:row.entity_id,
      type:row.collection,
      revision:row.revision,
      visibility:row.visibility,
      status:row.status,
      importance:row.importance,
      pinned:Boolean(row.pinned),
      supersededBy:row.superseded_by
    };
  }
  check(){
    if(this.closed)fail('CLOSED','Authority is closed',409);
  }
  transaction(fn){
    this.check();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const result=fn();
      this.db.exec('COMMIT');
      return result;
    }
    catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(key){
    this.check();
    return JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
  }
  set(key,value){
    this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(value),key);
  }
  nextRevision(){
    const revision=this.get('revision')+1;
    this.set('revision',revision);
    return revision;
  }
  audit(entry){
    this.db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify(entry));
  }
  close(){
    if(!this.closed){
      this.db.close();
      this.closed=true;
    }
  }
}
