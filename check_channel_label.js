const { supabase, COL_SETTINGS } = require('./services/database');

async function getChannelLabel() {
    const { data: config } = await supabase.from(COL_SETTINGS).select('label_channel').eq('id', 'config').single();
    console.log(`Current label_channel: "${config?.label_channel}"`);
}

getChannelLabel().catch(console.error);
