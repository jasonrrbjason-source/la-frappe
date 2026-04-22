const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.railway' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkCreds() {
    const { data, error } = await supabase
        .from('bot_state')
        .select('value')
        .eq('id', 'wa_backup::tct_0752981714::creds')
        .single();
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Creds found. Registered:', data.value?.registered);
    console.log('Noise Key exists:', !!data.value?.noiseKey);
}

checkCreds();
