export const notificationSchema = `CREATE TABLE IF NOT EXISTS abonent_notification_scopes (
  source text NOT NULL, res_path text NOT NULL, generation integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0, PRIMARY KEY(source,res_path)
);
CREATE TABLE IF NOT EXISTS abonent_user_notifications (
  source text NOT NULL, res_path text NOT NULL, id uuid NOT NULL, payload jsonb,
  deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source,res_path,id), FOREIGN KEY(source,res_path)
    REFERENCES abonent_notification_scopes(source,res_path) ON DELETE CASCADE
);`;

const conflict = () => Object.assign(new Error('Уведомления этого РЭС уже очищены. Обновите список.'), { status:409,code:'notifications_cleared' });
export function createNotificationStore(pool, ready) {
  async function transaction(source,path,generation,work) {
    await ready(); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO abonent_notification_scopes(source,res_path) VALUES($1,$2) ON CONFLICT DO NOTHING',[source,path]);
      const { rows:[scope] } = await client.query('SELECT generation,revision FROM abonent_notification_scopes WHERE source=$1 AND res_path=$2 FOR UPDATE',[source,path]);
      if (generation !== null && generation !== scope.generation) throw conflict();
      const changed = await work?.(client);
      if (changed) {
        const { rows:[updated] } = await client.query('UPDATE abonent_notification_scopes SET revision=revision+1 WHERE source=$1 AND res_path=$2 RETURNING generation,revision',[source,path]);
        Object.assign(scope,updated);
      }
      const { rows } = await client.query('SELECT payload,created_at FROM abonent_user_notifications WHERE source=$1 AND res_path=$2 AND NOT deleted ORDER BY created_at,id',[source,path]);
      await client.query('COMMIT');
      return { generation:scope.generation, revision:String(scope.revision), notifications:rows.map(row=>({ ...row.payload,createdAt:row.created_at })) };
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  return {
    listUserNotifications:(source,path)=>transaction(source,path,null),
    addUserNotification:(source,path,generation,note)=>transaction(source,path,generation,async client=>{
      const args=[source,path,note.id];
      const { rows:[existing] } = await client.query('SELECT deleted FROM abonent_user_notifications WHERE source=$1 AND res_path=$2 AND id=$3',args);
      if (existing?.deleted) throw Object.assign(new Error('Эта отметка уже удалена. Она не будет восстановлена повторной отправкой.'),{ status:410,code:'notification_deleted' });
      if (existing) return false;
      const { rows:[{ count }] } = await client.query('SELECT count(*) FROM abonent_user_notifications WHERE source=$1 AND res_path=$2 AND NOT deleted',[source,path]);
      if (Number(count)>=2000) throw Object.assign(new Error('В РЭС уже 2000 пользовательских уведомлений. Удалите ненужные.'),{status:409,code:'notification_limit'});
      await client.query('INSERT INTO abonent_user_notifications(source,res_path,id,payload) VALUES($1,$2,$3,$4::jsonb)',[...args,JSON.stringify(note)]);
      return true;
    }),
    deleteUserNotification:(source,path,generation,id)=>transaction(source,path,generation,async client=>{
      // A tombstone also protects a create whose HTTP response was lost.
      const result=await client.query(`INSERT INTO abonent_user_notifications(source,res_path,id,payload,deleted) VALUES($1,$2,$3,NULL,true)
        ON CONFLICT(source,res_path,id) DO UPDATE SET deleted=true,payload=NULL WHERE NOT abonent_user_notifications.deleted`,[source,path,id]);
      return result.rowCount>0;
    }),
    clearUserNotifications:(source,path,generation)=>transaction(source,path,generation,async client=>{
      await client.query('DELETE FROM abonent_user_notifications WHERE source=$1 AND res_path=$2',[source,path]);
      await client.query('UPDATE abonent_notification_scopes SET generation=generation+1 WHERE source=$1 AND res_path=$2',[source,path]);
      return true;
    }),
  };
}
