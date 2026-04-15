const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function listAllCreds() {
    console.log('Listing all creds in bot_state table...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key, updated_at')
        .eq('user_key', 'creds');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    if (data.length === 0) {
        console.log('No creds found in bot_state table.');
    } else {
        console.log(`Found ${data.length} creds entries:`);
        data.forEach(entry => {
            console.log(` - ID: ${entry.id}, Namespace: ${entry.namespace}, Updated: ${entry.updated_at}`);
        });
    }
}

listAllCreds();
