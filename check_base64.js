const { db } = require('./config/firebase');

async function checkProducts() {
    try {
        const snapshot = await db.collection('bot_products').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.image_url && data.image_url.startsWith('data:')) {
                console.log(`Product ${data.name} HAS base64!`);
            }
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkProducts();
