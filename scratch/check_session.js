const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSession(sessionId) {
    console.log(`Checking session: ${sessionId}`);
    const { data: primary, error: err1 } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key, updated_at')
        .filter('id', 'like', `%::${sessionId}::%`);
    
    if (err1) {
        console.error('Error fetching primary session:', err1);
    } else {
        console.log(`Found ${primary.length} entries for session ${sessionId}`);
        primary.forEach(entry => {
            console.log(` - ID: ${entry.id}, Namespace: ${entry.namespace}, Key: ${entry.user_key}, Updated: ${entry.updated_at}`);
        });
    }

    const { data: backup, error: err2 } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key, updated_at')
        .filter('id', 'like', `wa_backup::${sessionId}::%`);

    if (err2) {
        console.error('Error fetching backup session:', err2);
    } else {
        console.log(`Found ${backup.length} entries in backup for session ${sessionId}`);
        backup.forEach(entry => {
            console.log(` - ID: ${entry.id}, Namespace: ${entry.namespace}, Key: ${entry.user_key}, Updated: ${entry.updated_at}`);
        });
    }
}

async function run() {
    await checkSession('tct_0752981714');
    await checkSession('la-frappe');
    await checkSession('default');
}

run();
