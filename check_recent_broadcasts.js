const { supabase, COL_BROADCASTS } = require('./services/database');

async function checkRecentBroadcasts() {
    console.log('--- Checking Recent Broadcasts ---');
    const { data } = await supabase.from(COL_BROADCASTS).select('*').order('created_at', { ascending: false }).limit(5);
    if (!data || data.length === 0) {
        console.log('No broadcasts found.');
        return;
    }

    data.forEach(b => {
        console.log(`[${b.id.substring(0, 5)}] Total: ${b.total_target}, Success: ${b.success}, Failed: ${b.failed}, Blocked: ${b.blocked}, Status: ${b.status}`);
    });
}

checkRecentBroadcasts().catch(console.error);
