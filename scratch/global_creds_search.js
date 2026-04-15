const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function globalCredsSearch() {
    console.log('Searching for any ID containing "creds" in bot_state...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key, updated_at')
        .ilike('id', '%creds%');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log(`Found ${data.length} matches:`);
    data.forEach(entry => {
        console.log(` - ID: ${entry.id}, Namespace: ${entry.namespace}, Key: ${entry.user_key}, Updated: ${entry.updated_at}`);
    });
}

globalCredsSearch();
