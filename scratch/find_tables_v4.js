const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function findAnyTableWithData() {
    console.log('Searching for any table containing WhatsApp-like data across multiple schemas...');
    
    // We try to query a system view to list all tables
    // Since we cannot do raw SQL easily, we try to use the 'rpc' to call a function 'get_tables' if it exists
    // OR we try to query 'information_schema.tables'
    
    const { data: tables, error } = await supabase.from('bot_state').select('id').limit(1);
    if (error) console.log('Error querying bot_state:', error.message);
    
    // Let's try to query 'information_schema.tables' via the client if bypassing security
    // Actually, let's just try even more names
    const names = [
        'wa_session', 'wa_sessions', 'whatsapp_sessions', 'baileys_sessions',
        'bot_auth', 'wa_auth', 'whatsapp_auth', 'baileys_auth',
        'sessions', 'accounts', 'tokens', 'auth_tokens'
    ];
    
    for (const name of names) {
        const { data, error } = await supabase.from(name).select('*').limit(1);
        if (!error && data) {
            console.log(`FOUND TABLE: ${name}`);
        }
    }
}

findAnyTableWithData();
