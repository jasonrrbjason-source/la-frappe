const { db } = require('./config/firebase');

async function checkSettings() {
    try {
        const snap = await db.collection('bot_settings').get();
        snap.forEach(doc => {
            console.log(`Doc ID: ${doc.id}`);
            console.log(JSON.stringify(doc.data(), null, 2));
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkSettings();
