const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function exhaustiveTableSearch() {
    console.log('Exhaustive table search...');
    const tables = [
        'wa_sessions', 'whatsapp_sessions', 'baileys_sessions', 'bot_auth', 
        'wa_auth', 'whatsapp_auth', 'baileys_auth', 'session_data', 
        'connection_state', 'authState', 'creds', 'whatsapp_creds',
        'bot_state_lerelais', 'bot_state_la_frappe', 'bot_state_backup'
    ];
    
    for (const t of tables) {
        const { error } = await supabase.from(t).select('count').limit(1);
        if (!error) {
            console.log(`Table FOUND: ${t}`);
        }
    }
}

exhaustiveTableSearch();
