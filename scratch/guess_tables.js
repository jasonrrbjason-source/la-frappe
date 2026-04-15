const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function guessTables() {
    console.log('Guessing more table names...');
    const guesses = [
        'bot_auth', 'bot_sessions', 'whatsapp_auth', 'whatsapp_creds', 
        'baileys_auth', 'baileys_creds', 'auth_info', 'whatsapp_state'
    ];
    
    for (const g of guesses) {
        const { error } = await supabase.from(g).select('*').limit(1);
        if (!error) {
            console.log(`Table FOUND: ${g}`);
        }
    }
}

guessTables();
