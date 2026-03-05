const { db } = require('./config/firebase');

async function checkProducts() {
    try {
        const snapshot = await db.collection('bot_products').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            console.log(`Product: ${data.name}`);
            console.log(`Image URL: ${data.image_url}`);
            console.log('---');
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkProducts();
