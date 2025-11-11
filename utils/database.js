// Centralised PostgreSQL connection management helpers
require('dotenv').config();

const { Pool } = require('pg');

const LOG_PREFIX = '[db]';

let poolInstance = null;
let closingPromise = null;
let beforeExitHookRegistered = false;
let shutdownSignalsRegistered = false;

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveSsl(connectionString, explicitOverride) {
  if (typeof explicitOverride !== 'undefined') {
    return explicitOverride;
  }
  if (!connectionString) {
    return undefined;
  }
  const lowered = connectionString.toLowerCase();
  const isLocal = lowered.includes('localhost') || lowered.includes('127.0.0.1') || lowered.includes('::1');
  if (isLocal) {
    return false;
  }
  return { rejectUnauthorized: false };
}

function describeConnectionTarget(connectionString) {
  if (!connectionString) {
    return '(missing DATABASE_URL)';
  }
  try {
    const url = new URL(connectionString);
    const databaseName = (url.pathname || '').replace(/^\//, '') || '(default)';
    const host = url.hostname || '(unknown-host)';
    const port = url.port || '(default)';
    return `${url.protocol}//${host}:${port}/${databaseName}`;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Unable to parse DATABASE_URL for logging:`, err.message);
    return '(unparseable connection string)';
  }
}

function buildPoolConfig(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL;

  if (!connectionString) {
    console.error(`${LOG_PREFIX} DATABASE_URL is not set. Database operations will fail until it is provided.`);
  }

  const config = {
    connectionString,
    ssl: resolveSsl(connectionString, options.ssl),
    max: parseNumber(process.env.PG_POOL_MAX, options.max),
    idleTimeoutMillis: parseNumber(process.env.PG_IDLE_TIMEOUT_MS, options.idleTimeoutMillis || 30000),
    connectionTimeoutMillis: parseNumber(process.env.PG_CONNECTION_TIMEOUT_MS, options.connectionTimeoutMillis || 2000),
    ...options.poolConfig
  };

  // Remove undefined entries to avoid overriding pg defaults.
  Object.keys(config).forEach((key) => {
    if (typeof config[key] === 'undefined') {
      delete config[key];
    }
  });

  return config;
}

function registerBeforeExitHook() {
  if (beforeExitHookRegistered) {
    return;
  }
  beforeExitHookRegistered = true;
  process.once('beforeExit', async () => {
    await closePool('beforeExit');
  });
}

function initPool(options = {}) {
  if (poolInstance) {
    return poolInstance;
  }

  const config = buildPoolConfig(options);
  poolInstance = new Pool(config);
  const target = describeConnectionTarget(config.connectionString);
  console.info(`${LOG_PREFIX} Pool initialised -> ${target}`);

  poolInstance.on('error', (err) => {
    console.error(`${LOG_PREFIX} Unexpected client error (pooled connection likely lost).`, {
      message: err.message,
      code: err.code,
      time: new Date().toISOString()
    });
  });

  registerBeforeExitHook();
  return poolInstance;
}

function getPool(options = {}) {
  return initPool(options);
}

async function closePool(reason = 'manual-close') {
  if (!poolInstance) {
    return;
  }
  if (closingPromise) {
    return closingPromise;
  }

  const pool = poolInstance;
  poolInstance = null;

  closingPromise = pool.end()
    .then(() => {
      console.info(`${LOG_PREFIX} Pool closed (${reason}).`);
    })
    .catch((err) => {
      console.error(`${LOG_PREFIX} Error while closing pool (${reason}).`, err);
    })
    .finally(() => {
      closingPromise = null;
    });

  return closingPromise;
}

function registerPoolShutdown({
  signals = ['SIGINT', 'SIGTERM'],
  exitOnFinish = false,
  exitCode = 0
} = {}) {
  if (shutdownSignalsRegistered) {
    return;
  }
  shutdownSignalsRegistered = true;

  const handleSignal = (signal) => {
    closePool(`signal:${signal}`).finally(() => {
      if (exitOnFinish) {
        const code = signal === 'SIGINT' ? 130 : exitCode;
        process.exit(code);
      } else {
        try {
          process.kill(process.pid, signal);
        } catch (err) {
          const fallbackCode = signal === 'SIGINT' ? 130 : exitCode;
          process.exit(fallbackCode);
        }
      }
    });
  };

  signals.forEach((signal) => {
    process.once(signal, () => handleSignal(signal));
  });
}

async function withClient(callback, options = {}) {
  const pool = getPool(options);
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function checkConnection(options = {}) {
  const start = Date.now();
  try {
    const { rows } = await getPool(options).query('SELECT 1 as ok');
    return { ok: true, result: rows[0], latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code, latency_ms: Date.now() - start };
  }
}

module.exports = {
  initPool,
  getPool,
  closePool,
  withClient,
  checkConnection,
  registerPoolShutdown
};

