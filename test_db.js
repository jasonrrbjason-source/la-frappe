require('dotenv').config();
const { supabase } = require('./config/supabase');
async function test() {
   const { data } = await supabase.from('bot_users').select('id, platform, platform_id, is_livreur, is_active').limit(5);
   console.log(data);
}
test();
