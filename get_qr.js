const { useSupabaseAuthState } = require('./services/database');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

async function start() {
    const sessionId = 'pairing_temp_' + Math.floor(Math.random() * 1000000);
    console.log(`🚀 Génération d'un QR code temporaire (Session: ${sessionId})...`);

    const BaileysRaw = await import('@whiskeysockets/baileys');
    const Baileys = BaileysRaw.default || BaileysRaw;
    const makeWASocket = Baileys.default || Baileys.makeWASocket || BaileysRaw.makeWASocket || Baileys;
    
    const { state, saveCreds } = await useSupabaseAuthState(sessionId);

    // Version found in their code
    const version = [2, 3000, 1015901307];

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Safari", "17.0"]
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📡 [QR REÇU]');
            await qrcode.toFile('./temp_qr.png', qr, { width: 512 });
            console.log('✅ QR Code sauvegardé dans temp_qr.png');
            process.exit(0);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔌 Connexion fermée (Code: ${code}).`);
            process.exit(0);
        }
    });

    setTimeout(() => {
        console.log('⌛ Timeout: Pas de QR reçu.');
        process.exit(0);
    }, 45000);
}

start().catch(console.error);
