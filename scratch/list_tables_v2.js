const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function listAllTablesReally() {
    console.log('Querying pg_catalog to find all tables...');
    // We can use a raw SQL query via RPC or just try to guess more names
    // But Supabase JS doesn't have a direct raw SQL for security reasons.
    // However, we can try to query 'information_schema.tables' if allowed.
    
    // We try many common names first
    const tables = [
        'bot_state', 'wa_state', 'sessions', 'auth', 'auth_state', 'whatsapp_session', 
        'baileys_state', 'baileys_auth', 'wa_auth', 'bot_sessions'
    ];

    for (const t of tables) {
        const { data, error, count } = await supabase.from(t).select('*', { count: 'exact', head: true });
        if (!error) {
            console.log(`Table exists: ${t} (${count} rows)`);
        }
    }
}

listAllTablesReally();
