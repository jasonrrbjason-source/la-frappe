const { supabase, COL_USERS } = require('./services/database');

async function checkUserCounts() {
    console.log('--- Checking User Counts ---');
    const { data: allUsers } = await supabase.from(COL_USERS).select('id, platform, type, is_blocked');
    console.log(`Total users in DB: ${allUsers.length}`);

    const blocked = allUsers.filter(u => u.is_blocked);
    const unblocked = allUsers.filter(u => !u.is_blocked);
    console.log(`Blocked: ${blocked.length}`);
    console.log(`Unblocked (Expected for broadcast): ${unblocked.length}`);

    const usersWithTypeUser = unblocked.filter(u => u.type === 'user');
    const usersWithNullType = unblocked.filter(u => u.type === null || u.type === undefined);
    const groups = unblocked.filter(u => u.type === 'group');

    console.log(`Unblocked - Type 'user': ${usersWithTypeUser.length}`);
    console.log(`Unblocked - Type NULL/Undefined: ${usersWithNullType.length}`);
    console.log(`Unblocked - Type 'group': ${groups.length}`);

    const sumUserAndNull = usersWithTypeUser.length + usersWithNullType.length;
    console.log(`Sum (User + Null): ${sumUserAndNull}`);
}

checkUserCounts().catch(console.error);
