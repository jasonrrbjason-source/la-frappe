const { db } = require('./config/firebase');

async function checkSettings() {
    try {
        const doc = await db.collection('bot_settings').doc('settings').get();
        if (doc.exists) {
            console.log(JSON.stringify(doc.data(), null, 2));
        } else {
            console.log('No settings doc');
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkSettings();
