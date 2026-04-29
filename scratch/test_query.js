
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function testQuery() {
    try {
        console.log('Testing ALTER TABLE paciente...');
        const start = Date.now();
        await pool.query(`ALTER TABLE paciente ADD COLUMN IF NOT EXISTS usuarioid INTEGER`);
        console.log('Finished in', Date.now() - start, 'ms');
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await pool.end();
    }
}

testQuery();
