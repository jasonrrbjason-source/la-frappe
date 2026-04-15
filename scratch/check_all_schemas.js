const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAllSchemas() {
    console.log('Trying to find any WhatsApp credentials in the entire database...');
    // We try to query 'bot_state' specifically in other schemas if possible
    // But usually we only have access to 'public'
    
    // Let's try to query 'bot_state' and see ALL rows again, very carefully
    const { data, error } = await supabase
        .from('bot_state')
        .select('*');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log(`Analyzing ${data.length} rows in bot_state...`);
    const waRows = data.filter(d => d.id.startsWith('wa_') || d.namespace?.includes('wa'));
    console.log(`Found ${waRows.length} rows starting with wa_ or having wa in namespace.`);
    waRows.forEach(r => console.log(` - ID: ${r.id}, Namespace: ${r.namespace}, UserKey: ${r.user_key}`));

    // If still nothing, let's search for the SESSION ID from the logs: 'la-frappe'
    const laFrappeRows = data.filter(d => d.id.includes('la-frappe'));
    console.log(`Found ${laFrappeRows.length} rows containing 'la-frappe'.`);
    laFrappeRows.forEach(r => console.log(` - ID: ${r.id}, Namespace: ${r.namespace}`));
}

checkAllSchemas();
