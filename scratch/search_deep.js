const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function searchDeep() {
    console.log('Searching for WhatsApp credential patterns in the VALUE column of bot_state...');
    
    // Pattern to look for in JSONB
    // Baileys 'creds' object has a 'noiseKey'
    const { data, error } = await supabase
        .from('bot_state')
        .select('id, namespace, user_key, updated_at')
        .filter('value->>noiseKey', 'not.is', null);
    
    if (error) {
        // If the above fails (sometimes filter on JSONB is tricky), try a broader approach
        console.warn('Initial search failed, trying broader search...');
        const { data: allData, error: allErr } = await supabase
            .from('bot_state')
            .select('id, namespace, value')
            .limit(1000);
        
        if (allErr) {
            console.error('Error fetching data:', allErr);
            return;
        }

        console.log(`Checking ${allData.length} records manually for creds patterns...`);
        const matches = allData.filter(d => {
            const val = JSON.stringify(d.value);
            return val.includes('noiseKey') || val.includes('signedIdentityKey');
        });

        if (matches.length === 0) {
            console.log('No records with WhatsApp credential patterns found.');
        } else {
            console.log(`Found ${matches.length} matching records!`);
            matches.forEach(m => {
                console.log(` - ID: ${m.id}, Namespace: ${m.namespace}`);
            });
        }
        return;
    }

    if (data.length === 0) {
        console.log('No direct matches for noiseKey in JSONB.');
    } else {
        console.log(`Found ${data.length} records containing noiseKey:`);
        data.forEach(d => console.log(` - ID: ${d.id}, Namespace: ${d.namespace}`));
    }
}

searchDeep();
