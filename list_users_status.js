const { supabase, COL_USERS } = require('./services/database');
(async () => {
    const { data: allUsers } = await supabase.from(COL_USERS).select('*');
    console.log('--- USERS BLOCKED ---');
    allUsers.filter(u => u.is_blocked).forEach(u => {
        console.log(`ID: ${u.id}, Name: ${u.first_name}, PlatformID: ${u.platform_id}, Reason: ${u.blocked_at || 'unknown'}`);
    });
    console.log('\n--- USERS NOT BLOCKED ---');
    allUsers.filter(u => !u.is_blocked).forEach(u => {
        console.log(`ID: ${u.id}, Name: ${u.first_name}, PlatformID: ${u.platform_id}`);
    });
})();
