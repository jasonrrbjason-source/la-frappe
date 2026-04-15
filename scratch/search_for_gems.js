const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function searchForGems() {
    console.log('Final search: Looking for rows where the VALUE contains valid Baileys creds keys (noiseKey)...');
    
    // We fetch EVERYTHING (limit 1000) and do a local string search
    const { data, error } = await supabase.from('bot_state').select('id, namespace, value');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    const matches = data.filter(d => {
        const str = JSON.stringify(d.value);
        return str.includes('noiseKey') || str.includes('signedPreKey');
    });

    if (matches.length > 0) {
        console.log(`Bingo! Found ${matches.length} rows with credential patterns!`);
        matches.forEach(m => {
            console.log(` - ID: ${m.id}, Namespace: ${m.namespace}`);
        });
    } else {
        console.log('Still nothing. The current database is definitively missing the credentials.');
    }
}

searchForGems();
