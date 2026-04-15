const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkLargeRows() {
    console.log('Searching for any large rows in bot_state that might be hidden session data...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, value');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    // Sort by value length
    const sorted = data.sort((a, b) => JSON.stringify(b.value).length - JSON.stringify(a.value).length);
    
    console.log('Top 20 largest rows:');
    sorted.slice(0, 20).forEach(d => {
        console.log(` - ID: ${d.id}, Namespace: ${d.namespace}, Size: ${JSON.stringify(d.value).length}`);
    });
}

checkLargeRows();
