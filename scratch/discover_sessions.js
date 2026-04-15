const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function discoverSessions() {
    console.log('Discovering all WhatsApp session IDs in bot_state...');
    const { data, error } = await supabase
        .from('bot_state')
        .select('id')
        .ilike('id', 'wa_%::%');
    
    if (error) {
        console.error('Error:', error);
        return;
    }

    const sessions = new Set();
    data.forEach(entry => {
        // ID format: namespace::sessionId::key
        const parts = entry.id.split('::');
        if (parts.length >= 2) {
            sessions.add(parts[1]);
        }
    });

    console.log('Found sessions:', Array.from(sessions));
}

discoverSessions();
