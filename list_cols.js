const { db } = require('./config/firebase');

async function listCollections() {
    try {
        const collections = await db.listCollections();
        collections.forEach(collection => {
            console.log(collection.id);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

listCollections();
