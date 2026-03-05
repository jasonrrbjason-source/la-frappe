const { db } = require('./config/firebase');

async function checkProducts() {
    try {
        const snapshot = await db.collection('bot_products').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            for (let key in data) {
                if (typeof data[key] === 'string' && data[key].length > 500) {
                    console.log(`Product ${data.name} has long field: ${key} (${data[key].length} chars)`);
                }
            }
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkProducts();
