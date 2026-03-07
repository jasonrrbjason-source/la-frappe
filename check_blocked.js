const { supabase, COL_USERS, decryptUser } = require('./services/database');
(async () => {
    const { data: allUsers } = await supabase.from(COL_USERS).select('*');
    const decryptedUsers = allUsers.map(u => decryptUser(u));

    console.log('--- BLOCKED USERS ---');
    const blocked = decryptedUsers.filter(u => u.is_blocked);
    console.log(`Count: ${blocked.length}`);
    blocked.forEach(u => {
        console.log(`- ID: ${u.id}, Name: ${u.first_name}, Username: ${u.username}, Blocked At: ${u.blocked_at || '?'}`);
    });

    console.log('\n--- ACTIVE USERS ---');
    const active = decryptedUsers.filter(u => !u.is_blocked);
    console.log(`Count: ${active.length}`);
    active.forEach(u => {
        // console.log(`- ID: ${u.id}, Name: ${u.first_name}, PlatformID: ${u.platform_id}`);
    });
})();
