const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkPhoneSessions() {
    console.log('Checking for sessions with phone numbers as IDs...');
    const ids = ['33752981714', '0752981714', '752981714', 'whatsapp_33752981714'];
    
    for (const id of ids) {
        const { data, error } = await supabase
            .from('bot_state')
            .select('id, namespace')
            .filter('id', 'like', `%${id}%`);
        
        if (!error && data.length > 0) {
            console.log(`Matches for "${id}":`, data.length);
            data.forEach(d => console.log(` - ID: ${d.id}, Namespace: ${d.namespace}`));
        }
    }
}

checkPhoneSessions();
