const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSettings() {
    console.log('Checking bot_settings...');
    const { data, error } = await supabase
        .from('bot_settings')
        .select('*');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    if (data.length === 0) {
        console.log('bot_settings table is empty.');
    } else {
        console.log(`Found ${data.length} settings records.`);
        data.forEach(s => {
            console.log(`Settings:`, JSON.stringify(s, null, 2));
        });
    }
}

checkSettings();
