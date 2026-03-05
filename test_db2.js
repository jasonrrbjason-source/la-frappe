require('dotenv').config();
const { supabase } = require('./config/supabase');
async function test() {
    console.log('Testing...');
    const { data, error } = await supabase.from('bot_users').select('*').eq('is_livreur', true).eq('is_available', true);
    console.log('Result:', data, error);
}
test();
