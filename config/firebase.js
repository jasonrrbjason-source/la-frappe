const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
require('dotenv').config();

let serviceAccount;

// ===== METHODE 1 : Base64 (Railway - ZERO problème de parsing) =====
if (process.env.FIREBASE_SA_BASE64) {
    try {
        const decoded = Buffer.from(process.env.FIREBASE_SA_BASE64, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
        console.log(`✅ Firebase connecté via Base64 (Projet: ${serviceAccount.project_id})`);
    } catch (e) {
        console.error('❌ Erreur décodage FIREBASE_SA_BASE64:', e.message);
        process.exit(1);
    }

    // ===== METHODE 2 : Variables individuelles =====
} else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    console.log(`✅ Firebase connecté via variables d'env (Projet: ${serviceAccount.projectId})`);

    // ===== METHODE 3 : Fichier JSON local =====
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const fullPath = saPath.startsWith('.') ? path.resolve(process.cwd(), saPath) : saPath;
    try {
        serviceAccount = require(fullPath);
        console.log(`✅ Chef de projet identifié : ${serviceAccount.project_id}`);
    } catch (e) {
        console.error(`❌ Impossible de charger Firebase à : ${fullPath}`);
        process.exit(1);
    }

    // ===== METHODE 4 : Fichier local par défaut =====
} else {
    const fallbackPath = path.resolve(process.cwd(), 'serviceAccountKey.json');
    try {
        serviceAccount = require(fallbackPath);
        console.log(`✅ Firebase chargé depuis fichier local (Projet: ${serviceAccount.project_id})`);
    } catch (e) {
        console.error('❌ Firebase credentials manquantes.');
        process.exit(1);
    }
}

const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = getFirestore(app, 'default');
console.log('📡 Instance Firestore connectée à la base "default"');

module.exports = { db, admin };
