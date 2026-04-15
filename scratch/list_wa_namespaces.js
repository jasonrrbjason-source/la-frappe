const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function listWaNamespaces() {
    console.log('Listing unique namespaces starting with wa_ in bot_state...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('namespace')
        .ilike('namespace', 'wa_%');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    const uniqueNamespaces = [...new Set(data.map(d => d.namespace))];
    console.log('Found namespaces:', uniqueNamespaces);
    
    for (const ns of uniqueNamespaces) {
        const { count, error: countErr } = await supabase
            .from('bot_state')
            .select('*', { count: 'exact', head: true })
            .eq('namespace', ns);
        console.log(` - Namespace ${ns}: ${count} entries`);
    }
}

listWaNamespaces();
