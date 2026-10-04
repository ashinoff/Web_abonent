import pg from 'pg';

const names = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
export function createPreparedStore(env = process.env) {
  if (!names.some(name => env[name])) return null;
  const missing = names.filter(name => !env[name]);
  const port = Number(env.DB_PORT);
  const pool = missing.length || !Number.isInteger(port) || port < 1 || port > 65535 ? null : new pg.Pool({
    host: env.DB_HOST, port, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
    max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: false,
  });
  let initialized;
  async function ready() {
    if (missing.length) throw new Error(`Отсутствуют переменные: ${missing.join(', ')}`);
    if (!pool) throw new Error('DB_PORT должен быть числом от 1 до 65535.');
    initialized ||= pool.query(`CREATE TABLE IF NOT EXISTS abonent_snapshots (
      source text NOT NULL, path text NOT NULL, role text NOT NULL, revision text NOT NULL,
      data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, path, role)
    )`).then(() => pool.query(`CREATE TABLE IF NOT EXISTS abonent_folder_status (
      source text NOT NULL, res_path text NOT NULL, enterprise_path text NOT NULL,
      enterprise_name text NOT NULL, res_name text NOT NULL,
      statuses jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, res_path)
    )`)).catch(error => { initialized = null; throw error; });
    await initialized;
  }
  return {
    ready,
    async get(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, data, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async getJson(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, data::text AS json, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async getRevision(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0]?.revision || null;
    },
    async getMeta(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async put(source, path, role, revision, data) {
      await ready();
      await pool.query(`INSERT INTO abonent_snapshots (source,path,role,revision,data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (source,path,role) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=now()`,
      [source, path, role, revision, data]);
    },
    async putRaw(source, path, role, revision, json) {
      await ready();
      await pool.query(`INSERT INTO abonent_snapshots (source,path,role,revision,data) VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (source,path,role) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=now()`,
      [source, path, role, revision, json]);
    },
    async putFolder(source, folder, statuses) {
      await ready();
      await pool.query(`INSERT INTO abonent_folder_status
        (source,res_path,enterprise_path,enterprise_name,res_name,statuses)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (source,res_path) DO UPDATE SET enterprise_path=EXCLUDED.enterprise_path,
        enterprise_name=EXCLUDED.enterprise_name,res_name=EXCLUDED.res_name,
        statuses=EXCLUDED.statuses,checked_at=now()`,
      [source, folder.path, folder.enterprisePath, folder.enterpriseName, folder.name, statuses]);
    },
    async markFile(source, path, role, state, updatedAt) {
      await ready();
      await pool.query(`UPDATE abonent_folder_status
        SET statuses=jsonb_set(statuses, ARRAY[$3], (statuses -> $3) || $4::jsonb), checked_at=now()
        WHERE source=$1 AND statuses -> $3 ->> 'path'=$2`,
      [source, path, role, JSON.stringify({ state, updatedAt })]);
    },
    async listFolders(source) {
      await ready();
      const { rows } = await pool.query(`SELECT enterprise_path,enterprise_name,res_path,res_name,statuses,checked_at
        FROM abonent_folder_status WHERE source=$1 ORDER BY enterprise_name,res_name`, [source]);
      return rows;
    },
    async pruneFolders(source, paths) {
      await ready();
      await pool.query('DELETE FROM abonent_folder_status WHERE source=$1 AND NOT (res_path = ANY($2::text[]))', [source, paths]);
    },
    close: () => pool?.end(),
  };
}
