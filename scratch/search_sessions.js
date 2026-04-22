const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.railway' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function search() {
    console.log('--- SEARCHING FOR SESSION ---');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id')
        .ilike('id', '%wa_session%');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Found IDs:', data.map(d => d.id));
    
    console.log('--- SEARCHING FOR BACKUP ---');
    const { data: bData, error: bError } = await supabase
        .from('bot_state')
        .select('id')
        .ilike('id', '%wa_backup%');
    
    if (bError) {
        console.error('BError:', bError);
        return;
    }

    console.log('Found Backup IDs:', bData.map(d => d.id));
}

search();
