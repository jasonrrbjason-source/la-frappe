const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function searchValuesForWhatsapp() {
    console.log('Searching all values in bot_state for "whatsapp"...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, value');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    const matches = data.filter(d => JSON.stringify(d.value).toLowerCase().includes('whatsapp'));
    console.log(`Found ${matches.length} matches.`);
    matches.forEach(m => {
        console.log(` - ID: ${m.id}, Namespace: ${m.namespace}`);
    });
}

searchValuesForWhatsapp();
