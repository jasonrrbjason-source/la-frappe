const crypto = require('crypto');
require('dotenv').config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 1000; // Réduit pour booster les performances de décryptage

/**
 * Récupère ou génère la clé de chiffrement à partir de la variable d'environnement
 */
function getKey(salt) {
    const masterKey = process.env.ENCRYPTION_KEY;
    if (!masterKey) {
        throw new Error('❌ ENCRYPTION_KEY manquante dans le fichier .env');
    }
    return crypto.pbkdf2Sync(masterKey, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Chiffre une chaîne de caractères
 * @param {string} text 
 * @returns {string} format: salt:iv:authTag:encryptedText
 */
function encrypt(text) {
    if (!text) return null;

    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getKey(salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Déchiffre une chaîne de caractères
 * @param {string} encryptedData 
 */
function decrypt(encryptedData) {
    if (!encryptedData || !encryptedData.includes(':')) return encryptedData;

    try {
        const [saltHex, ivHex, tagHex, encryptedText] = encryptedData.split(':');

        const salt = Buffer.from(saltHex, 'hex');
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const key = getKey(salt);

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        console.error('❌ Erreur de déchiffrement:', error.message);
        return "[Erreur de déchiffrement]";
    }
}

module.exports = { encrypt, decrypt };
