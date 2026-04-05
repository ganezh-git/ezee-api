import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import { environment } from './environment';

const pools: Map<string, Pool> = new Map();

function createPool(database: string): Pool {
  const config: PoolOptions = {
    host: environment.db.host,
    port: environment.db.port,
    user: environment.db.user,
    password: environment.db.password,
    database,
    connectionLimit: environment.db.poolSize,
    waitForConnections: true,
    queueLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10000,
    ...(environment.nodeEnv === 'production' ? { ssl: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: false } } : {}),
  };
  return mysql.createPool(config);
}

export function getPool(database: string): Pool {
  if (!pools.has(database)) {
    pools.set(database, createPool(database));
  }
  return pools.get(database)!;
}

// Shortcut accessors for each database
export const db = {
  portal: () => getPool(environment.databases.portal),
  login: () => getPool(environment.databases.login),
  permit: () => getPool(environment.databases.permit),
  permitModern: () => getPool(environment.databases.permitModern),
  vehicle: () => getPool(environment.databases.vehicle),
  safety: () => getPool(environment.databases.safety),
  visitor: () => getPool(environment.databases.visitor),
  inventory: () => getPool(environment.databases.inventory),
  stationery: () => getPool(environment.databases.stationery),
  reception: () => getPool(environment.databases.reception),
  library: () => getPool(environment.databases.library),
  permitBirla: () => getPool(environment.databases.permitBirla),
};

export async function testConnections(): Promise<{ name: string; status: string }[]> {
  const results: { name: string; status: string }[] = [];

  for (const [name, dbName] of Object.entries(environment.databases)) {
    try {
      const pool = getPool(dbName);
      const conn = await pool.getConnection();
      conn.release();
      results.push({ name, status: 'connected' });
    } catch (err: any) {
      results.push({ name, status: `failed: ${err.message}` });
    }
  }

  return results;
}

export async function closeAllPools(): Promise<void> {
  for (const [, pool] of pools) {
    await pool.end();
  }
  pools.clear();
}
