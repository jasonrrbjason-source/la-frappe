const { admin } = require('./config/firebase');

async function listFiles() {
    const buckets = [
        'la-frappe-cbc6f.appspot.com',
        'la-frappe-cbc6f.firebasestorage.app',
        'la-frappe-cbc6f'
    ];

    for (const b of buckets) {
        try {
            console.log(`Checking bucket: ${b}`);
            const bucket = admin.storage().bucket(b);
            const [files] = await bucket.getFiles();
            console.log(`Success! ${files.length} files found.`);
            files.slice(0, 5).forEach(f => console.log(` - ${f.name}`));
            break;
        } catch (err) {
            console.log(`Bucket ${b} failed: ${err.message}`);
        }
    }
    process.exit(0);
}

listFiles();
