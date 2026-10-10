import { fault } from './accounts.mjs';

export const adminSchema=`CREATE TABLE IF NOT EXISTS abonent_load_policy (
  source text NOT NULL, res_path text NOT NULL, blocked boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source,res_path)
);
CREATE TABLE IF NOT EXISTS abonent_admin_events (
  id bigserial PRIMARY KEY, source text NOT NULL, res_path text, category text NOT NULL,
  code text NOT NULL, message text NOT NULL, actor text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abonent_admin_events_source ON abonent_admin_events(source,id DESC);`;
export function resScope(path){
  if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.length>4096||path!=='/'&&path.slice(1).split('/').some(part=>!part||part==='.'||part==='..'))throw fault('Некорректный путь.');
  const parts=path.slice(1).split('/');return parts.length>=2?'/'+parts.slice(0,2).join('/'):null;
}
export function samePolicy(a,b){return String(a?.generation)===String(b?.generation)&&String(a?.globalGeneration)===String(b?.globalGeneration);}
export function assertPolicy(policy,expected){
  if(policy.blocked)throw fault('Загрузка этого РЭС приостановлена администратором.',403,'res_blocked');
  if(expected&&!samePolicy(policy,expected))throw fault('Данные РЭС изменены администратором. Повторите открытие.',409,'res_changed');
  return policy;
}
export function preparationIssue(error){
  const text=error?.message||'';
  if(error?.code==='res_blocked'||error?.code==='res_changed')return {code:error.code,message:error.message};
  if(/памяти|memory|heap|лимит.*МБ/i.test(text))return{code:'memory_limit',message:'Недостаточно памяти или превышен размер пакета.'};
  if(/превысила|timeout|timed?\s*out|abort/i.test(text))return{code:'timeout',message:'Подготовка прервана или превысила время ожидания.'};
  if(error?.upstreamStatus===404)return{code:'source_missing',message:'Файл или папка не найдены на Диске.'};
  if(error?.upstreamStatus===403)return{code:'source_access',message:'Диск запретил доступ к файлу или папке.'};
  if(error?.upstreamStatus===429)return{code:'source_limit',message:'Диск временно ограничил запросы.'};
  if(/Excel|книг|лист|столбц|format|corrupt/i.test(text))return{code:'workbook_error',message:'Не удалось прочитать или распознать книгу Excel.'};
  return{code:'prepare_failed',message:'Подготовка не завершилась. Проверьте файл и соединение.'};
}
export function createAdminStore(pool,ready){
  async function tx(work){await ready();const c=await pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
  async function lock(c,source,path){
    await c.query('INSERT INTO abonent_load_policy(source,res_path) VALUES($1,$2) ON CONFLICT DO NOTHING',[source,'/']);
    const global=(await c.query('SELECT * FROM abonent_load_policy WHERE source=$1 AND res_path=$2 FOR UPDATE',[source,'/'])).rows[0];
    let local;if(path&&path!=='/'){
      await c.query('INSERT INTO abonent_load_policy(source,res_path) VALUES($1,$2) ON CONFLICT DO NOTHING',[source,path]);
      local=(await c.query('SELECT * FROM abonent_load_policy WHERE source=$1 AND res_path=$2 FOR UPDATE',[source,path])).rows[0];
    }
    return {blocked:Boolean(global.blocked||local?.blocked),localBlocked:Boolean(local?.blocked),globalBlocked:global.blocked,
      generation:String(local?.generation??0),globalGeneration:String(global.generation)};
  }
  async function event(c,source,{resPath=null,category='maintenance',code,message,actor=null}){
    await c.query('INSERT INTO abonent_admin_events(source,res_path,category,code,message,actor) VALUES($1,$2,$3,$4,$5,$6)',[source,resPath,category,code,message.slice(0,500),actor]);
    await c.query('DELETE FROM abonent_admin_events WHERE source=$1 AND id NOT IN (SELECT id FROM abonent_admin_events WHERE source=$1 ORDER BY id DESC LIMIT 1000)',[source]);
  }
  async function statusPolicy(c,source,path,blocked){
    await c.query(`UPDATE abonent_folder_status SET statuses=(SELECT COALESCE(jsonb_object_agg(key,value||jsonb_build_object('state',CASE WHEN $3 THEN 'blocked' ELSE CASE WHEN value?'path' THEN 'pending' ELSE 'missing' END END)),'{}'::jsonb) FROM jsonb_each(statuses)),checked_at=now() WHERE source=$1 AND ($2='/' OR res_path=$2)`,[source,path,blocked]);
  }
  return {
    lockPolicy:lock,
    policyTransaction:tx,
    getLoadPolicy:(source,path)=>tx(c=>lock(c,source,resScope(path))),
    assertLoadAllowed:(source,path,expected)=>tx(async c=>assertPolicy(await lock(c,source,resScope(path)),expected)),
    async listLoadPolicies(source){await ready();return(await pool.query('SELECT res_path,blocked,generation,updated_at FROM abonent_load_policy WHERE source=$1',[source])).rows;},
    setLoadPolicy:(source,path,blocked,actor)=>tx(async c=>{
      if(path!=='/'&&resScope(path)!==path)throw fault('Выберите РЭС.');
      await lock(c,source,path);
      await c.query('UPDATE abonent_load_policy SET blocked=$3,generation=generation+1,updated_at=now() WHERE source=$1 AND res_path=$2',[source,path,blocked]);
      await statusPolicy(c,source,path,blocked);
      await event(c,source,{resPath:path,code:blocked?'loading_blocked':'loading_enabled',message:blocked?'Загрузка приостановлена.':'Загрузка разрешена.',actor});
    }),
    clearResData:(source,path,actor)=>tx(async c=>{
      if(path!=='/'&&resScope(path)!==path)throw fault('Выберите РЭС.');
      await lock(c,source,path);
      await c.query('UPDATE abonent_load_policy SET blocked=true,generation=generation+1,updated_at=now() WHERE source=$1 AND res_path=$2',[source,path]);
      const removed=await c.query(`DELETE FROM abonent_snapshots WHERE source=$1 AND ($2='/' OR '/'||split_part(path,'/',2)||'/'||split_part(path,'/',3)=$2)`,[source,path]);
      await statusPolicy(c,source,path,true);
      await event(c,source,{resPath:path,code:'data_cleared',message:`Удалено пакетов: ${removed.rowCount}. Загрузка приостановлена.`,actor});
      return{removed:removed.rowCount};
    }),
    appendAdminEvent:(source,data)=>tx(c=>event(c,source,data)),
    async listAdminEvents(source){await ready();return(await pool.query('SELECT id,res_path,category,code,message,actor,created_at FROM abonent_admin_events WHERE source=$1 ORDER BY id DESC LIMIT 100',[source])).rows;},
    async clearAdminEvents(source,actor){return tx(async c=>{await c.query('DELETE FROM abonent_admin_events WHERE source=$1',[source]);await event(c,source,{code:'journal_cleared',message:'Журнал очищен.',actor});});},
    async databaseOverview(source){
      await ready();const {rows:[sizes]}=await pool.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
        pg_total_relation_size('abonent_snapshots')::text AS snapshot_table_bytes`);
      const {rows:[counts]}=await pool.query(`SELECT count(*)::int AS snapshot_count,COALESCE(sum(COALESCE(pg_column_size(payload_json),pg_column_size(data),0)),0)::text AS payload_bytes,
        count(*) FILTER(WHERE source=$1)::int AS current_snapshot_count FROM abonent_snapshots`,[source]);
      const {rows:[users]}=await pool.query('SELECT count(*)::int AS account_count FROM abonent_accounts');
      return{...sizes,...counts,...users};
    },
    async listAdminFolders(source){
      await ready();return(await pool.query(`SELECT f.enterprise_path,f.enterprise_name,f.res_path,f.res_name,f.statuses,f.checked_at,
        COALESCE(p.blocked,false) AS local_blocked,COALESCE(g.blocked,false) AS global_blocked,
        COALESCE(p.blocked,false) OR COALESCE(g.blocked,false) AS load_blocked,
        COALESCE(s.package_count,0)::int AS package_count,COALESCE(s.payload_bytes,0)::text AS payload_bytes
        FROM abonent_folder_status f LEFT JOIN abonent_load_policy p ON p.source=f.source AND p.res_path=f.res_path
        LEFT JOIN abonent_load_policy g ON g.source=f.source AND g.res_path='/'
        LEFT JOIN (SELECT source,'/'||split_part(path,'/',2)||'/'||split_part(path,'/',3) AS res_path,count(*) AS package_count,
          sum(COALESCE(pg_column_size(payload_json),pg_column_size(data),0)) AS payload_bytes FROM abonent_snapshots WHERE source=$1 GROUP BY source,res_path) s ON s.source=f.source AND s.res_path=f.res_path
        WHERE f.source=$1 ORDER BY f.enterprise_name,f.res_name`,[source])).rows;
    },
  };
}
