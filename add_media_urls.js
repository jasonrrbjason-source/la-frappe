require('dotenv').config();
const { supabase } = require('./config/supabase');
async function run() {
    const { error } = await supabase.rpc('execute_sql', { query: 'ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS media_urls JSONB DEFAULT \'[]\'::jsonb;' });
    console.log('Result:', error);
}
run();
