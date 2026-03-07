const { supabase, COL_USERS } = require('./services/database');
(async () => {
    const { data: allUsers } = await supabase.from(COL_USERS).select('id, type, is_blocked');
    console.log('--- NULL TYPE CHECK ---');
    const unblocked = allUsers.filter(u => !u.is_blocked);
    const withType = unblocked.filter(u => u.type !== null && u.type !== undefined);
    const withoutType = unblocked.filter(u => u.type === null || u.type === undefined);

    console.log(`Unblocked users: ${unblocked.length}`);
    console.log(`- With type set: ${withType.length}`);
    console.log(`- With type NULL/undefined: ${withoutType.length}`);

    // Test Supabase query directly
    const { data: queryResult } = await supabase.from(COL_USERS).select('id').eq('is_blocked', false).neq('type', 'group');
    console.log(`Supabase query (neq('type', 'group')) returned: ${queryResult.length} rows`);
})();
