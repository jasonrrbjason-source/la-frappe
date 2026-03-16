require('dotenv').config({ path: '.env' });
const { WhatsAppSessionChannel } = require('./channels/WhatsAppSessionChannel');

async function test() {
    const sessionId = process.env.WHATSAPP_SESSION_ID || 'tct_0c6f6c21';
    const was = new WhatsAppSessionChannel({ sessionId });
    
    console.log(`🚀 Initializing test for session: ${sessionId}`);
    await was.initialize();
    
    was.onMessage((msg) => {
        console.log(`📩 Recu message de ${msg.from}: ${msg.text}`);
    });

    await was.start();
    
    // Attendre la connexion
    console.log('⏳ Attente de connexion (15s)...');
    await new Promise(r => setTimeout(r, 15000));
    
    if (was.isActive) {
        // Numéro de test passé en argument
        const target = process.argv[2];
        if (target) {
            const jid = target.includes('@s.whatsapp.net') ? target : `${target}@s.whatsapp.net`;
            console.log(`📤 Envoi d'un message de test à ${jid}...`);
            await was.sendMessage(jid, "✅ *TEST WHATSAPP*\n\nLe bot est maintenant configuré et prêt sur WhatsApp !");
            console.log('✅ Envoyé !');
        } else {
            console.log('⚠️ Aucun numéro cible spécifié. Utilisation: node test_wa.js 33612345678');
        }
    } else {
        console.log('❌ Échec de connexion (QR non scanné ?)');
    }
    
    process.exit(0);
}

test();
