const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function listTables() {
    console.log('Fetching all tables in the database...');
    // Supabase doesn't have a direct "list tables" in JS, but we can try to query some metadata if we have permissions or just try common names
    const commonTables = ['bot_state', 'sessions', 'wa_sessions', 'auth_state'];
    for (const table of commonTables) {
        const { data, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
        if (!error) {
            console.log(`Table exists: ${table} (${data ? data.length : 0} rows)`);
        } else {
            console.log(`Table ${table} check failed: ${error.message}`);
        }
    }
}

listTables();
