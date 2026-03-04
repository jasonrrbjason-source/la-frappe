const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
require('dotenv').config();

let serviceAccount;

// ===== METHODE 1 : Variables individuelles (Railway / Render / Heroku) =====
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    console.log(`✅ Firebase connecté via variables d'env (Projet: ${serviceAccount.projectId})`);

    // ===== METHODE 2 : Fichier JSON local (développement local) =====
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const fullPath = saPath.startsWith('.')
        ? path.resolve(process.cwd(), saPath)
        : saPath;

    try {
        serviceAccount = require(fullPath);
        console.log(`✅ Chef de projet identifié : ${serviceAccount.project_id}`);
    } catch (e) {
        console.error(`❌ Impossible de charger le fichier Firebase à : ${fullPath}`);
        process.exit(1);
    }

    // ===== METHODE 3 : JSON complet en variable (fallback) =====
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log(`✅ Initialisation via FIREBASE_SERVICE_ACCOUNT_JSON (Projet: ${serviceAccount.project_id})`);
    } catch (e) {
        console.error('❌ Erreur lors du parsing de FIREBASE_SERVICE_ACCOUNT_JSON.');
        process.exit(1);
    }
} else {
    // METHODE 4 : Fallback automatique - chercher le fichier à la racine
    const fallbackPath = path.resolve(process.cwd(), 'serviceAccountKey.json');
    try {
        serviceAccount = require(fallbackPath);
        console.log(`✅ Firebase chargé depuis le fichier local (Projet: ${serviceAccount.project_id})`);
    } catch (e) {
        console.error('❌ Firebase credentials manquantes. Aucune méthode de connexion trouvée.');
        process.exit(1);
    }
}

// Initialisation de l'App
const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// CRITIQUE : Votre base de données s'appelle "default" (sans parenthèses)
const db = getFirestore(app, 'default');

console.log('📡 Instance Firestore connectée à la base "default"');

module.exports = { db, admin };
