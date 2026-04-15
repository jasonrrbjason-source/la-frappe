const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function listAllTablesForReal() {
    console.log('Querying all tables in public schema...');
    // We can use RPC if there is a postgres function, but usually there isn't.
    // However, we can try to query 'pg_tables' or 'information_schema.tables'
    
    const { data: tables, error } = await supabase.rpc('get_tables'); // Long shot
    if (error) {
        console.warn('RPC get_tables failed, trying to query information_schema via RPC or direct...');
    }

    // Try to guess even more aggressively based on common Baileys/Supabase patterns
    const complexGuesses = [
        'bot_state', 'bot_sessions', 'wa_sessions', 'baileys_state', 'whatsapp_sessions',
        'auth_state', 'authState', 'whatsappAuthState', 'baileysAuthState'
    ];
    
    for (const g of complexGuesses) {
        const { count, error } = await supabase.from(g).select('*', { count: 'exact', head: true });
        if (!error) {
            console.log(`Table exists: ${g} (${count} rows)`);
        }
    }
}

listAllTablesForReal();
