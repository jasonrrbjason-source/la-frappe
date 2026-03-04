require('dotenv').config();
const { registry } = require('./channels/ChannelRegistry');
const { TelegramChannel } = require('./channels/TelegramChannel');
const { WhatsAppChannel } = require('./channels/WhatsAppChannel');
const { createServer } = require('./server');
const { setupStartHandler } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem } = require('./handlers/order_system');
const { handleWhatsAppMessage } = require('./handlers/whatsapp');

const PORT = process.env.PORT || 3000;

async function main() {
    console.log('🚀 Démarrage de l\'environnement Multi-Plateforme (Telegram + WhatsApp)...\n');

    // 1. Initialisation du Canal Telegram
    const telegramTok = process.env.BOT_TOKEN;
    if (!telegramTok) {
        console.error('❌ BOT_TOKEN manquant dans le fichier .env');
        process.exit(1);
    }
    const tgChannel = new TelegramChannel(telegramTok);
    await tgChannel.initialize();
    registry.register(tgChannel);

    // 2. Initialisation du Canal WhatsApp (Meta)
    const waConfig = {
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN
    };
    const waChannel = new WhatsAppChannel(waConfig);
    await waChannel.initialize();
    registry.register(waChannel);

    // 3. Liaison des Handlers
    // Telegram
    const telegrafBot = tgChannel.getBotInstance();
    setupStartHandler(telegrafBot);
    setupAdminHandlers(telegrafBot);
    setupOrderSystem(telegrafBot);

    // WhatsApp
    waChannel.onMessage(async (msg) => {
        await handleWhatsAppMessage(waChannel, msg);
    });

    // 4. Démarrage du Serveur Web (Admin + Webhooks)
    const serverStarted = new Promise((resolve) => {
        try {
            const server = createServer();
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`🌐 Dashboard Admin : http://localhost:${PORT}/dashboard`);
                console.log(`🔗 Webhook WhatsApp : http(s)://votre-domaine/webhook/whatsapp`);
                resolve();
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`⚠️ Port ${PORT} déjà utilisé. Le dashboard ne sera pas accessible, mais le bot continue de tourner.`);
                } else {
                    console.error('❌ Erreur serveur:', err.message);
                }
                resolve();
            });
        } catch (err) {
            console.error('❌ Impossible de lancer le serveur web:', err.message);
            resolve();
        }
    });

    // 5. Démarrage des Canaux (Bot)
    const botStarted = (async () => {
        console.log('🤖 Démarrage des canaux de communication...');
        try {
            await registry.startAll();
            console.log('✅ Bots opérationnels !');
        } catch (err) {
            console.error('❌ Erreur au démarrage des bots:', err.message);
        }
    })();

    await Promise.all([serverStarted, botStarted]);

    console.log('\n🚀 Environnement prêt !');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Graceful shutdown
    const stop = async () => {
        console.log('\n🛑 Arrêt des services...');
        await registry.stopAll();
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

main().catch((error) => {
    console.error('❌ Erreur fatale au démarrage:', error);
    process.exit(1);
});
