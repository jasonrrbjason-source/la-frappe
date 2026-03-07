const { supabase, COL_SETTINGS } = require('./services/database');

async function checkSchema() {
    const { data, error } = await supabase.from(COL_SETTINGS).select('*').limit(1);
    if (error) {
        console.error('Error fetching settings:', error);
        return;
    }
    console.log('Columns in settings table:', Object.keys(data[0] || {}));
}

checkSchema().catch(console.error);
