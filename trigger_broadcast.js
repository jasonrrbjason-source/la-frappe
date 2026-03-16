require('dotenv').config({ path: process.env.RAILWAY_ENVIRONMENT ? '.env.railway' : '.env' });
const { broadcastMessage } = require('./services/broadcast');

async function triggerTestBroadcast() {
    console.log('📣 Lancement d\'une diffusion de test sur tous les canaux...');
    
    const message = "🚀 TEST DE DIFFUSION MULTI-CANAUX\n\nCe message est envoyé simultanément sur Telegram et WhatsApp.\n\nEst-ce que vous le recevez bien ?";
    
    // On cible tous les 'users'
    const result = await broadcastMessage('users', message, {
        poll_options: "Oui reçu !|Non, bizarre"
    });
    
    console.log('\n📊 Résultat de la diffusion :');
    console.log(`✅ Succès : ${result.success}`);
    console.log(`❌ Échecs : ${result.failed}`);
    console.log(`🚫 Bloqués : ${result.blocked}`);
    console.log(`👥 Total ciblés : ${result.total}`);
    
    process.exit(0);
}

triggerTestBroadcast().catch(err => {
    console.error('❌ Erreur lors de la diffusion :', err);
    process.exit(1);
});
