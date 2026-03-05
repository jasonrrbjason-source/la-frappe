const { admin } = require('./config/firebase');

async function listFiles() {
    try {
        const bucket = admin.storage().bucket();
        const [files] = await bucket.getFiles();
        console.log(`${files.length} files found in bucket.`);
        files.slice(0, 10).forEach(file => {
            console.log(file.name);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

listFiles();
