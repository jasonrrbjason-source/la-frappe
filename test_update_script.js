require('dotenv').config();
const { supabase } = require('./config/supabase');
const { ts, makeDocId } = require('./services/database');

async function test() {
    console.log('Testing...');
    const docId = makeDocId('telegram', '5176746955');
    const { data, error } = await supabase.from('bot_users').update({
        is_livreur: true,
        is_available: true,
        updated_at: ts()
    }).eq('id', docId).select();

    console.log('Result:', data, error);
}
test();
