const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.railway' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function listAll() {
    console.log('--- LISTING EVERYTHING IN bot_state ---');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Found IDs:', data.map(d => d.id));
}

listAll();
