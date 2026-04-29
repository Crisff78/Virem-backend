
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function checkLocks() {
    try {
        console.log('Checking for active locks and long running queries...');
        const res = await pool.query(`
            SELECT pid, now() - query_start AS duration, query, state
            FROM pg_stat_activity
            WHERE state != 'idle' AND query NOT LIKE '%pg_stat_activity%'
            ORDER BY duration DESC;
        `);
        console.log('Active queries:', JSON.stringify(res.rows, null, 2));

        const locks = await pool.query(`
            SELECT
                blocked_locks.pid AS blocked_pid,
                blocking_locks.pid AS blocking_pid,
                blocked_activity.query AS blocked_query,
                blocking_activity.query AS blocking_query
            FROM pg_catalog.pg_locks blocked_locks
            JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_locks.pid = blocked_activity.pid
            JOIN pg_catalog.pg_locks blocking_locks
                ON blocking_locks.locktype = blocked_locks.locktype
                AND blocking_locks.DATABASE IS NOT DISTINCT FROM blocked_locks.DATABASE
                AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
                AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
                AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
                AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
                AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
                AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
                AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
                AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
                AND blocking_locks.pid != blocked_locks.pid
            JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_locks.pid = blocking_activity.pid
            WHERE NOT blocked_locks.GRANTED;
        `);
        console.log('Locks:', JSON.stringify(locks.rows, null, 2));

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkLocks();
