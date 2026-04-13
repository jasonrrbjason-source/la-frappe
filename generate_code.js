const { useSupabaseAuthState } = require('./services/database');
const pino = require('pino');
require('dotenv').config();

async function start() {
    const sessionId = process.env.WHATSAPPD_SESSION_ID || 'tct_0752981714';
    const phoneNumber = '+33752981714';

    console.log(`🚀 Démarrage du jumelage pour ${phoneNumber} (Session: ${sessionId})...`);

    const BaileysRaw = await import('@whiskeysockets/baileys');
    const Baileys = BaileysRaw.default || BaileysRaw;
    
    // Baileys components
    const makeWASocket = Baileys.default || Baileys.makeWASocket || BaileysRaw.makeWASocket || Baileys;
    const { state, saveCreds } = await useSupabaseAuthState(sessionId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Safari", "17.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📡 [QR REÇU] Génération de l\'image...');
            const qrcode = require('qrcode');
            await qrcode.toFile('./whatsapp_qr.png', qr);
            console.log('✅ QR Code sauvegardé dans whatsapp_qr.png');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔌 Connexion fermée (Code: ${statusCode}).`);
            if (statusCode !== 401) { // 401 = Logged out, don't retry same session normally
                 console.log('Relancez le script pour réessayer.');
            }
            process.exit(0);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connecté avec succès !');
            process.exit(0);
        }
    });

    // Demande du code de jumelage
    if (!sock.authState.creds.registered) {
        try {
            console.log('⏳ Demande du code à WhatsApp...');
            // On attend 5s pour laisser le temps au QR de s'afficher d'abord s'il le souhaite
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.replace(/\+/g, ''));
                    console.log('\n****************************************');
                    console.log(`✅ VOTRE CODE WHATSAPP : ${code}`);
                    console.log('****************************************\n');
                } catch (e) {
                    console.error('❌ Échec demande code pairing:', e.message);
                }
            }, 5000);
        } catch (err) {
            console.error('❌ Erreur lors de la demande du code :', err.message);
        }
    } else {
        console.log('ℹ️ Cet appareil est déjà enregistré.');
    }

}

start().catch(console.error);
