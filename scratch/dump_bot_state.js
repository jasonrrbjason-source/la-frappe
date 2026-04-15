const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function dumpTable() {
    console.log('Dumping 50 rows from bot_state...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('*')
        .limit(50);
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    if (data.length === 0) {
        console.log('bot_state table is empty.');
    } else {
        console.log(`Found ${data.length} entries:`);
        data.forEach(entry => {
            console.log(` - ID: ${entry.id}, Namespace: ${entry.namespace}, UserKey: ${entry.user_key}`);
        });
    }
}

dumpTable();
