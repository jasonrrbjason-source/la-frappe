const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.railway' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function listSessions() {
    console.log('--- LISTING SESSIONS IN bot_state ---');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id')
        .filter('id', 'like', 'wa_session%');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Found IDs:', data.map(d => d.id));
}

listSessions();
