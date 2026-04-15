const { useSupabaseAuthState } = require('../services/database');
require('dotenv').config();

async function scanForActiveSessions() {
    console.log('Scanning for active sessions in Supabase...');
    const candidates = ['la-frappe', 'tct_0752981714', 'default', 'brilliant-renewal', 'whatsapp', 'bot'];
    
    for (const sid of candidates) {
        process.stdout.write(`Checking ${sid}... `);
        try {
            const { state } = await useSupabaseAuthState(sid);
            if (state.creds && state.creds.noiseKey) {
                console.log('✅ FOUND ACTIVE SESSION!');
            } else {
                console.log('❌ Empty');
            }
        } catch (e) {
            console.log('⚠️ Error:', e.message);
        }
    }
}

scanForActiveSessions();
