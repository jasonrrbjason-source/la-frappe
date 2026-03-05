require('dotenv').config();
const { supabase } = require('./config/supabase');
async function test() {
    const { error } = await supabase.rpc('execute_sql', { query: 'ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT false;' });
    console.log('RPC error:', error);
}
test();
