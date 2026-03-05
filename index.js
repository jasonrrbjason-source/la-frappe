require('dotenv').config();
const { createServer, setBotInstance } = require('./server');
const { Telegraf } = require('telegraf');
const { setupStartHandler } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem } = require('./handlers/order_system');
const { setBroadcastBot } = require('./services/broadcast');

const PORT = process.env.PORT || 3000;

async function main() {
    console.log('🚀 Démarrage du Bot Telegram La Frappe...\n');

    // 1. Initialisation du Bot Telegram
    const telegramTok = process.env.BOT_TOKEN;
    if (!telegramTok) {
        console.error('❌ BOT_TOKEN manquant.');
        process.exit(1);
    }

    const bot = new Telegraf(telegramTok);
    setBotInstance(bot);
    setBroadcastBot(bot);

    // ERROR HANDLER — empêche le bot de crash sur une erreur
    bot.catch((err, ctx) => {
        console.error(`❌ Erreur bot [${ctx.updateType}]:`, err.message);
        try {
            ctx.reply('⚠️ Une erreur est survenue, réessayez.').catch(() => { });
        } catch (e) { }
    });

    // 2. Liaison des Handlers
    setupStartHandler(bot);
    setupAdminHandlers(bot);
    setupOrderSystem(bot);

    // Process-level error handlers
    process.on('unhandledRejection', (err) => {
        console.error('⚠️ Unhandled Rejection:', err.message || err);
    });
    process.on('uncaughtException', (err) => {
        console.error('⚠️ Uncaught Exception:', err.message || err);
    });

    // 3. Démarrage du Serveur Web (Dashboard Admin)
    const serverStarted = new Promise((resolve) => {
        try {
            const server = createServer();
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`🌐 Dashboard Admin : http://localhost:${PORT}/dashboard`);
                resolve();
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`⚠️ Port ${PORT} déjà utilisé.`);
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

    // 4. Démarrage du Bot Telegram
    const botStarted = (async () => {
        console.log('🤖 Lancement du bot Telegram...');
        try {
            await bot.launch();
            console.log('✅ Bot Telegram opérationnel !');

            // Lancement du timer automatique (toutes les 6h)
            startAutomatedTimer(bot);

        } catch (err) {
            console.error('❌ Erreur au démarrage du bot:', err.message);
        }
    })();

    await Promise.all([serverStarted, botStarted]);

    console.log('\n🚀 Environnement prêt !');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Graceful shutdown
    const stop = async () => {
        console.log('\n🛑 Arrêt des services...');
        bot.stop('SIGTERM');
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

// Fonction pour le message automatique toutes les 6h
function startAutomatedTimer(bot) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    // Premier déclenchement dans 6h
    setInterval(async () => {
        try {
            console.log('🕒 Exécution du timer automatique (6h)...');
            const { getAppSettings } = require('./services/database');
            const { broadcastMessage } = require('./services/broadcast');

            const settings = await getAppSettings();
            if (settings.msg_auto_timer && settings.msg_auto_timer.length > 5) {
                await broadcastMessage('all', settings.msg_auto_timer);
            }
        } catch (err) {
            console.error('❌ Erreur timer automatique:', err.message);
        }
    }, SIX_HOURS);
}

main().catch((error) => {
    console.error('❌ Erreur fatale au démarrage:', error);
    process.exit(1);
});
