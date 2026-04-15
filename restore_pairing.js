require('dotenv').config();
const { WhatsAppSessionChannel } = require('./channels/WhatsAppSessionChannel');

async function restorePairing() {
    console.log('--- RECONSTITUTION DE LA CONNEXION WHATSAPP ---');
    console.log('Mode : Pairing Code (Pas de scan QR nécessaire)');
    
    // On utilise l'ID stable qui fonctionnait hier
    const sessionId = process.env.WHATSAPPD_SESSION_ID || 'tct_0752981714';
    const pairingPhone = '33752981714';
    
    console.log(`Cible : ${pairingPhone} (Session: ${sessionId})`);

    const channel = new WhatsAppSessionChannel({ sessionId });
    
    // On surcharge le waLog pour voir ce qui se passe
    const originalWaLog = require('./services/wa_log_shared').waLog;
    global.waLog = (msg) => {
        console.log(msg);
        if (msg.includes('CODE REÇU :')) {
            const code = msg.split('CODE REÇU :')[1].trim();
            console.log('\n' + '='.repeat(40));
            console.log('✅ VOTRE CODE DE JUMELAGE EST : ' + code);
            console.log('='.repeat(40));
            console.log('\nINSTRUCTIONS :');
            console.log('1. Ouvrez WhatsApp sur votre téléphone');
            console.log('2. Menu > Appareils connectés > Lier un appareil');
            console.log('3. Sélectionnez "Lier avec le numéro de téléphone" tout en bas');
            console.log('4. Entrez le code ci-dessus.');
            console.log('\nUne fois lié, le bot s\'activera automatiquement.');
        }
    };

    try {
        await channel.initialize();
        // Option pairingPhone force Baileys à demander un code au lieu du QR
        await channel.start({ pairingPhone });
    } catch (err) {
        console.error('ERREUR:', err.message);
        process.exit(1);
    }
}

restorePairing();
