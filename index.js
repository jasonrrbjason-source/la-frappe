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

    // Suppression de la description "Que peut faire ce bot ?" (Card d'accueil Telegram)
    bot.telegram.setMyDescription('').catch(() => { });
    bot.telegram.setMyShortDescription('').catch(() => { });

    // 2. Middleware Global : Tracking & Nettoyage
    const { registerUser } = require('./services/database');
    bot.use(async (ctx, next) => {
        try {
            // Enregistrement automatique de la cible (user ou group)
            if (ctx.chat) {
                // Pour ctx.from on garde platformUser, mais on passe aussi le type de chat
                const platformUser = {
                    id: ctx.chat.id,
                    type: ctx.chat.type,
                    username: ctx.chat.username || ctx.from?.username,
                    first_name: ctx.chat.title || ctx.from?.first_name,
                    last_name: ctx.from?.last_name || '',
                    language_code: ctx.from?.language_code
                };
                await registerUser(platformUser);
            }

            // Pré-chargement des données pour la rapidité
            const { getAppSettings, getUser } = require('./services/database');
            const trackId = ctx.chat?.type === 'private' ? `telegram_${ctx.from?.id}` : `telegram_${ctx.chat?.id}`;
            const [settings, userProfile] = await Promise.all([
                getAppSettings(),
                getUser(trackId)
            ]);

            ctx.state.settings = settings;
            ctx.state.user = userProfile;

            if (ctx.message && !ctx.message.from?.is_bot) {
                await next();
                // Nettoyage flux constant (uniquement en privé)
                if (ctx.chat.type === 'private') {
                    await ctx.deleteMessage().catch(() => { });
                }
            } else {
                await next();
            }
        } catch (e) {
            console.error('Middleware error:', e.message);
            await next();
        }
    });

    // ERROR HANDLER — empêche le bot de crash sur une erreur
    bot.catch((err, ctx) => {
        console.error(`❌ Erreur bot [${ctx.updateType}]:`, err.message);
        try {
            ctx.reply('⚠️ Une erreur est survenue, réessayez.').catch(() => { });
        } catch (e) { }
    });

    // liaison des Handlers
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
            console.log('🕒 Exécution du timer automatique et nettoyage (6h)...');
            const { getAppSettings, getAllActiveUsers, db } = require('./services/database');
            const { broadcastMessage } = require('./services/broadcast');

            // 1. Nettoyage du "flux" (suppression des messages traqués)
            const users = await getAllActiveUsers();
            for (const user of users) {
                if (user.tracked_messages && user.tracked_messages.length > 0) {
                    const chatId = user.platform_id;
                    // Supprimer un par un (avec délai leger pour éviter rate limit)
                    for (const msgId of user.tracked_messages) {
                        try { await bot.telegram.deleteMessage(chatId, msgId); } catch (e) { }
                    }

                    // Notifier et forcer le /start
                    await bot.telegram.sendMessage(chatId,
                        "⏳ <b>Session expirée (6h)</b>\n\n" +
                        "Par mesure de sécurité et pour garder le flux propre, votre session a été réinitialisée.\n\n" +
                        "➡ Veuillez taper /start pour continuer.", { parse_mode: 'HTML' }
                    ).catch(() => { });

                    // Reset dans la DB
                    const { supabase } = require('./config/supabase');
                    await supabase.from('bot_users').update({
                        tracked_messages: [],
                        last_session_reset: new Date().toISOString()
                    }).eq('id', user.doc_id);
                }
            }

            // 2. Broadcast Optionnel
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
