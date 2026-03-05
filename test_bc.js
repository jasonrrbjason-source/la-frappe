require('dotenv').config();
const { supabase } = require('./config/supabase');
async function test() {
   const data = {
        message: 'test',
        media_urls: [],
        total_target: 10,
        target_platform: 'telegram',
        status: 'in_progress'
   };
   const { error } = await supabase.from('bot_broadcasts').insert([data]);
   console.log('Result:', error);
}
test();
