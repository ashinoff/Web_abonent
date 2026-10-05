import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPreparedStore } from '../prepared-store.mjs';

// Use a separate test database; never fall back to the application's DB_*.
const env = Object.fromEntries(['HOST','PORT','NAME','USER','PASSWORD'].map(name =>
  [`DB_${name}`, process.env[`TEST_DB_${name}`]]));

test('PostgreSQL snapshot migration and connection recovery', { skip: !env.DB_HOST }, async t => {
  const pool = new pg.Pool({ host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD, max: 1, ssl: false });
  const source = 'integration:' + randomUUID(), path = '/sample.xlsx', role = 'consumption';
  const applicationName = 'snapshot-test:' + randomUUID(), originalApplicationName = process.env.PGAPPNAME;
  process.env.PGAPPNAME = applicationName;
  const legacy = { format:1, role, months:[{y:2022,m:0}], rows:[['000123',0,null,-2.5]], warnings:[] };
  let store;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS abonent_snapshots (
      source text NOT NULL, path text NOT NULL, role text NOT NULL, revision text NOT NULL,
      data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source,path,role))`);
    await pool.query('INSERT INTO abonent_snapshots(source,path,role,revision,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [source,path,role,'legacy',JSON.stringify(legacy)]);
    store = createPreparedStore(env);
    await store.ready();
    const repeated = createPreparedStore(env);
    try { await repeated.ready(); } finally { await repeated.close(); }

    await t.test('existing JSONB snapshot remains readable after idempotent migration', async () => {
      assert.deepEqual((await store.get(source,path,role)).data, legacy);
      assert.deepEqual(JSON.parse((await store.getJson(source,path,role)).json), legacy);
      assert.equal(await store.getRevision(source,path,role), 'legacy');
    });

    await t.test('new JSON package retains the exact text and rejects a broken replacement', async () => {
      const json = '{ "format":1, "role":"consumption", "rows":[["000123",0,null,-2.5]], "months":[{"y":2022,"m":0}], "warnings":[] }';
      await store.putRaw(source,path,role,'new',json);
      assert.equal((await store.getJson(source,path,role)).json, json);
      assert.deepEqual((await store.get(source,path,role)).data, JSON.parse(json));
      await assert.rejects(store.putRaw(source,path,role,'broken','{"format":'));
      assert.equal(await store.getRevision(source,path,role), 'new');
      assert.equal((await store.getJson(source,path,role)).json, json);
      const { put } = store;
      await put(source,path,role,'object',legacy);
      assert.deepEqual((await store.get(source,path,role)).data, legacy);
    });

    await t.test('an idle database disconnect is logged and the next read reconnects', async () => {
      const messages = [];
      t.mock.method(console,'error',message => messages.push(String(message)));
      await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=current_database() AND usename=current_user AND state='idle' AND pid<>pg_backend_pid() AND application_name=$1`,[applicationName]);
      await new Promise(resolve => setTimeout(resolve,100));
      assert.ok(messages.some(message => message.startsWith('DB error:')));
      assert.deepEqual((await store.get(source,path,role)).data, legacy);
    });
    await t.test('shared notifications persist, concurrent writes are idempotent, and clearing never recreates old notes',async()=>{
      const a='/ЭС/РЭС А',b='/ЭС/РЭС Б';
      const note={id:randomUUID(),fields:{meter:'0001',account:'001'},address:'Тестовый адрес',note:'Проверить',type:'user',location:{lat:43.6,lon:39.72,precision:'manual'}};
      const result=await Promise.all([store.addUserNotification(source,a,0,note),store.addUserNotification(source,a,0,note)]);
      assert.equal(result[0].notifications.length,1);assert.equal(result[1].notifications.length,1);
      await Promise.all([store.addUserNotification(source,a,0,{...note,id:randomUUID()}),store.addUserNotification(source,a,0,{...note,id:randomUUID()})]);
      assert.equal((await store.listUserNotifications(source,a)).notifications.length,3);
      await store.addUserNotification(source,b,0,note);
      const cleared=await store.clearUserNotifications(source,a,0);assert.equal(cleared.generation,1);assert.equal(cleared.notifications.length,0);
      await assert.rejects(store.addUserNotification(source,a,0,note),error=>error.code==='notifications_cleared');
      assert.equal((await store.listUserNotifications(source,b)).notifications.length,1);
      await store.deleteUserNotification(source,b,0,note.id);
      await assert.rejects(store.addUserNotification(source,b,0,note),error=>error.code==='notification_deleted');
      await store.addUserNotification(source,a,1,{...note,id:randomUUID()});
      assert.deepEqual((await store.get(source,path,role)).data,legacy);
    });
  } finally {
    if (originalApplicationName === undefined) delete process.env.PGAPPNAME;
    else process.env.PGAPPNAME = originalApplicationName;
    await pool.query('DELETE FROM abonent_snapshots WHERE source=$1',[source]);
    await pool.query('DELETE FROM abonent_notification_scopes WHERE source=$1',[source]);
    await store?.close();
    await pool.end();
  }
});
