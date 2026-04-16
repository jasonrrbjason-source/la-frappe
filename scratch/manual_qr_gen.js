require('dotenv').config();
// Monkeypatch BEFORE requiring WhatsAppSessionChannel
const db = require('../services/database');
const originalUseSupabase = db.useSupabaseAuthState;
db.useSupabaseAuthState = async function() {
    const res = await originalUseSupabase.apply(this, arguments);
    return {
        ...res,
        checkLock: async () => null // Bypasser le lock interne
    };
};

const { WhatsAppSessionChannel } = require('../channels/WhatsAppSessionChannel');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

async function generateQR() {
    console.log('🔄 RÉGÉNÉRATION DU QR CODE WHATSAPP...');
    
    const sessionId = process.env.WHATSAPPD_SESSION_ID || 'tct_0752981714';
    console.log(`Session ID: ${sessionId}`);

    // On force le nettoyage pour régénérer
    const channel = new WhatsAppSessionChannel({ sessionId });
    
    // Surcharge des logs pour capturer le QR et arrêter dès qu'il est là
    global.waLog = (msg) => {
        console.log(msg);
    };

    try {
        await channel.initialize();
        
        // On écoute l'événement QR avant de démarrer
        // Note: Dans WhatsAppSessionChannel.js, le QR est loggé et sauvegardé en image.
        
        console.log('🚀 Démarrage du canal (cela va générer un QR si non connecté)...');
        await channel.start();
        
        // On laisse un peu de temps pour que le QR soit généré
        setTimeout(() => {
            const qrPath = path.join(process.cwd(), 'whatsapp_qr.png');
            if (fs.existsSync(qrPath)) {
                console.log('\n✅ QR CODE RÉGÉNÉRÉ AVEC SUCCÈS !');
                console.log('Fichier : whatsapp_qr.png');
                process.exit(0);
            } else {
                console.log('\n⏳ Attente du QR code...');
            }
        }, 15000);

    } catch (err) {
        console.error('❌ ERREUR:', err.message);
        process.exit(1);
    }
}

generateQR();
