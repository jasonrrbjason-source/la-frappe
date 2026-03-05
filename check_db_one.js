const { db } = require('./config/firebase');

async function checkProducts() {
    try {
        const snapshot = await db.collection('bot_products').limit(1).get();
        snapshot.forEach(doc => {
            const data = doc.data();
            console.log(JSON.stringify(data, null, 2));
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkProducts();
