const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function dumpAllIds() {
    console.log('Dumping all IDs from bot_state...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log(`Summary of all ${data.length} IDs:`);
    // Group by prefix to see patterns
    const groups = {};
    data.forEach(d => {
        const prefix = d.id.split(':')[0].split('::')[0];
        groups[prefix] = (groups[prefix] || 0) + 1;
        if (d.id.includes('creds') || d.id.includes('auth') || d.id.includes('session')) {
            console.log(`!!! IMPORTANT: ${d.id} (Namespace: ${d.namespace})`);
        }
    });
    console.log('Prefix distribution:', groups);
}

dumpAllIds();
