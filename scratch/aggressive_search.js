const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function aggressiveSearch() {
    console.log('Aggressive search for anything WhatsApp related in bot_state...');
    // We try many patterns
    const patterns = ['wa_%', '%session%', '%auth%', '%creds%', 'tct_%', 'la-frappe%'];
    
    for (const pattern of patterns) {
        const { data, error } = await supabase
            .from('bot_state')
            .select('id, namespace, user_key')
            .ilike('id', pattern);
        
        if (!error && data.length > 0) {
            console.log(`Pattern "${pattern}" found ${data.length} rows.`);
            data.slice(0, 10).forEach(d => console.log(` - ${d.id} (${d.namespace})`));
            if (data.length > 10) console.log('   ...');
        }
    }
}

aggressiveSearch();
