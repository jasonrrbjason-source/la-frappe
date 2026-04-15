const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkOtherSchemas() {
    console.log('Checking for other schemas besides public...');
    // We can try to query 'information_schema.schemata'
    // But since we can't do raw SQL, we can try to use the 'schema' option in createClient if we knew the name.
    
    // However, common names in these projects are 'monshopbot', 'lerelais', 'lafabrik'
    const schemas = ['monshopbot', 'lerelais', 'lafabrik', 'lafrappe'];
    for (const schema of schemas) {
        try {
            const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema } });
            const { count, error } = await client.from('bot_state').select('*', { count: 'exact', head: true });
            if (!error) {
                console.log(`Schema found: ${schema}. 'bot_state' has ${count} rows.`);
                if (count > 0) {
                    const { data } = await client.from('bot_state').select('id').limit(10);
                    console.log(`Sample IDs in ${schema}.bot_state:`, data.map(d => d.id));
                }
            } else {
                console.log(`Schema ${schema} not accessible or bot_state missing: ${error.message}`);
            }
        } catch (e) {
            console.log(`Error checking schema ${schema}:`, e.message);
        }
    }
}

checkOtherSchemas();
