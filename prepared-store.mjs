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
    )`).catch(error => { initialized = null; throw error; });
    await initialized;
  }
  return {
    ready,
    async get(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, data, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async put(source, path, role, revision, data) {
      await ready();
      await pool.query(`INSERT INTO abonent_snapshots (source,path,role,revision,data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (source,path,role) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=now()`,
      [source, path, role, revision, data]);
    },
    close: () => pool?.end(),
  };
}
