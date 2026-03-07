const { getUserCount } = require('./services/database');
(async () => {
    const count = await getUserCount();
    console.log('Total users (blocked + unblocked):', count);
    const { supabase, COL_USERS } = require('./services/database');
    const { data: allUsers } = await supabase.from(COL_USERS).select('id, is_blocked, type');
    console.log('Detailed counts:');
    console.log('- Total in Supabase:', allUsers.length);
    console.log('- Not blocked:', allUsers.filter(u => !u.is_blocked).length);
    console.log('- Type is group:', allUsers.filter(u => u.type === 'group').length);
    console.log('- Not blocked & Not group:', allUsers.filter(u => !u.is_blocked && u.type !== 'group').length);
})();
