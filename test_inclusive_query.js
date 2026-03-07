const { getAllActiveUsers } = require('./services/database');

async function test() {
    console.log('--- Testing inclusive user filter ---');
    const users = await getAllActiveUsers(null, 'user');
    console.log(`Total users found with type 'user' (inclusive of NULL): ${users.length}`);

    const nullTypeUsers = users.filter(u => !u.type);
    console.log(`Of those, ${nullTypeUsers.length} have NULL/undefined type.`);

    const groupUsers = users.filter(u => u.type === 'group');
    console.log(`Of those, ${groupUsers.length} are groups (expected 0).`);
}

test().catch(console.error);
