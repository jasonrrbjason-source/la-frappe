require('dotenv').config({ path: process.env.RAILWAY_ENVIRONMENT ? '.env.railway' : '.env' });
const { validateLicense } = require('./services/license');
if (!validateLicense()) {
    console.error('❌ Licence invalide ou manquante. Arrêt.');
    process.exit(1);
}
const { createServer, setBotInstance } = require('./server');
const { Telegraf } = require('telegraf');
const { setupStartHandler } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem } = require('./handlers/order_system');
const { setBroadcastBot } = require('./services/broadcast');

const PORT = process.env.PORT || 3000;

async function main() {
    console.log('🚀 Démarrage du Bot Telegram...\n');

    // 1. Initialisation du Bot Telegram
    const telegramTok = process.env.BOT_TOKEN;
    if (!telegramTok) {
        console.error('❌ BOT_TOKEN manquant.');
        process.exit(1);
    }

    const bot = new Telegraf(telegramTok);
    setBotInstance(bot);
    setBroadcastBot(bot);

    // 2. Middleware Global : Tracking & Nettoyage
    const { registerUser, getAppSettings } = require('./services/database');

    // Configuration de la carte de partage du bot (Description Telegram)
    getAppSettings().then(settings => {
        if (settings.bot_description) bot.telegram.setMyDescription(settings.bot_description).catch(() => { });
        if (settings.bot_short_description) bot.telegram.setMyShortDescription(settings.bot_short_description).catch(() => { });
    }).catch(() => { });
    // Middleware de maintenance - intercept ALL messages
    bot.use(async (ctx, next) => {
        try {
            const settings = await getAppSettings();

            // Check if maintenance mode is enabled
            if (settings.maintenance_mode === true || settings.maintenance_mode === 'true') {
                const adminContact = settings.maintenance_contact || 'https://t.me/lafrappex';
                const maintenanceMessage = settings.maintenance_message || '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l\'admin : @lafrappex';

                if (ctx.callbackQuery) {
                    await ctx.answerCbQuery(maintenanceMessage, { show_alert: true }).catch(() => { });
                    return;
                }

                if (ctx.message) {
                    await ctx.reply(maintenanceMessage + `\n\n📱 Contact : ${adminContact}`, { parse_mode: 'HTML' }).catch(() => { });
                    await ctx.deleteMessage().catch(() => { });
                    return;
                }

                // Pour les autres types de updates, on répond aussi
                if (ctx.updateType === 'callback_query') {
                    await ctx.answerCbQuery(maintenanceMessage, { show_alert: true }).catch(() => { });
                    return;
                }

                return;
            }

            // Continue with normal middleware only if not in maintenance
            const user = ctx.from;
            if (user && !user.is_bot) {
                // Enregistrement / Mise à jour automatique (inclut last_active)
                const platformUser = {
                    id: user.id,
                    type: ctx.chat?.type || 'private',
                    username: user.username,
                    first_name: user.first_name,
                    last_name: user.last_name || '',
                    language_code: user.language_code
                };

                const [{ user: registeredUser }, currentSettings] = await Promise.all([
                    registerUser(platformUser),
                    getAppSettings()
                ]);

                if (registeredUser && registeredUser.is_blocked) {
                    if (ctx.callbackQuery) {
                        return ctx.answerCbQuery("⛔️ Votre compte est suspendu.", { show_alert: true }).catch(() => { });
                    }
                    return ctx.reply("⛔️ <b>ACCÈS REFUSÉ</b>\n\nVotre compte a été suspendu par l'administration. Contactez le support pour plus d'informations.", { parse_mode: 'HTML' }).catch(() => { });
                }

                ctx.state.user = registeredUser;
                ctx.state.settings = currentSettings;
            } else {
                ctx.state.settings = await getAppSettings();
            }

            if (ctx.message && !ctx.message.from?.is_bot) {
                await next();
                // Nettoyage flux constant (uniquement en privé) - On ne bloque pas next()
                // if (ctx.chat?.type === 'private') {
                //    ctx.deleteMessage().catch(() => { });
                // }
            } else {
                await next();
            }
        } catch (e) {
            console.error('Middleware error:', e.message);
            await next();
        }
    });

    // ERROR HANDLER — empêche le bot de crash sur une erreur
    bot.catch(async (err, ctx) => {
        console.error(`❌ Bot Error [${ctx.updateType}]:`, err.message);
        try {
            if (ctx.callbackQuery) {
                await ctx.answerCbQuery("⚠️ Une erreur technique est survenue.", { show_alert: true }).catch(() => { });
            } else {
                await ctx.reply("⚠️ Désolé, une erreur est survenue. Retour au menu : /start").catch(() => { });
            }
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

            // Configuration du menu des commandes Telegram
            await bot.telegram.setMyCommands([
                { command: 'start', description: '🏠 Lancer le bot / Accueil' },
                { command: 'menu', description: '🛒 Voir le catalogue' },
                { command: 'orders', description: '📦 Mes commandes' },
                { command: 'help', description: '❓ Aide et support' }
            ]).catch(e => console.error('⚠️ Impossible de définir les commandes:', e.message));

            // Lancement du timer automatique (toutes les 6h)
            startAutomatedTimer(bot);

            // Lancement de la vérification des commandes planifiées (toutes les minutes)
            setInterval(() => checkPlannedOrders(bot), 60000);

            // Lancement de la vérification des paniers abandonnés (toutes les 30 minutes)
            const { checkAbandonedCarts } = require('./handlers/order_system');
            setInterval(() => checkAbandonedCarts(bot), 1800000);

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

// Vérification des commandes planifiées et notifications
async function checkPlannedOrders(bot) {
    try {
        const { getUpcomingPlannedOrders, markNotifSent, getAllLivreurs, getAppSettings } = require('./services/database');
        const orders = await getUpcomingPlannedOrders();
        const settings = await getAppSettings();
        if (orders.length === 0) return;

        const now = new Date();
        // Correction locale France (UTC+1 ou UTC+2)
        const nowParis = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }));

        for (const order of orders) {
            if (!order.scheduled_at) continue;

            // Format attendu: "YYYY-MM-DD HHhMM"
            const [datePart, timePart] = order.scheduled_at.split(' ');
            if (!datePart || !timePart) continue;

            const [h, m] = timePart.replace('h', ':').split(':');
            const schedDate = new Date(`${datePart}T${h}:${m}:00`); // Local time for current system usually matches server

            const diffMs = schedDate - nowParis;
            const diffMin = Math.round(diffMs / 60000);

            // Notification 1 heure avant (entre 55 et 65 min)
            if (diffMin <= 60 && diffMin > 30 && !order.notif_1h_sent) {
                await sendPlannedAlert(bot, order, '1h', settings);
                await markNotifSent(order.id, '1h');
            }

            // Notification 30 min avant (entre 0 et 30 min)
            if (diffMin <= 30 && diffMin > 0 && !order.notif_30m_sent) {
                await sendPlannedAlert(bot, order, '30m', settings);
                await markNotifSent(order.id, '30m');
            }
        }
    } catch (e) {
        console.error('❌ Error checkPlannedOrders:', e.message);
    }
}

async function sendPlannedAlert(bot, order, type, settings) {
    const timeLabel = type === '1h' ? '1 HEURE' : '30 MINUTES';
    const text = `⏰ <b>RAPPEL COMMANDE PLANIFIÉE</b>\n\n` +
        `La commande <b>#${order.id.substring(0, 5)}</b> doit être livrée dans environ <b>${timeLabel}</b>.\n\n` +
        `📦 ${order.product_name}\n` +
        `📍 ${order.address}\n` +
        `🕒 Prévu pour : <b>${order.scheduled_at}</b>\n\n` +
        (order.livreur_id ? `👤 Assigné à : ID ${order.livreur_id}` : `⚠️ <b>PERSONNE N'A PRIS CETTE COMMANDE !</b>`);

    // Si assigné : notifier le livreur
    if (order.livreur_id) {
        const livreurTgId = order.livreur_id.replace('telegram_', '');
        await bot.telegram.sendMessage(livreurTgId, text, { parse_mode: 'HTML' }).catch(() => { });
    }

    // Dans tous les cas (ou si non assigné), prévenir les admins
    if (settings.admin_telegram_id) {
        const admins = String(settings.admin_telegram_id).split(/[\s,]+/);
        for (const adminId of admins) {
            await bot.telegram.sendMessage(adminId.trim(), `📢 [INFO ADMIN] ${text}`, { parse_mode: 'HTML' }).catch(() => { });
        }
    }
}

// Fonction pour le message automatique toutes les 6h
function startAutomatedTimer(bot) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    // Premier déclenchement dans 6h
    setInterval(async () => {
        try {
            console.log('🕒 Exécution du timer automatique et nettoyage (6h)...');
            if (!validateLicense()) {
                console.warn('⚠️ Vérification de licence périodique échouée.');
            }
            const { getAppSettings, getAllActiveUsers, updateUserData } = require('./services/database');
            const { broadcastMessage } = require('./services/broadcast');

            // 1. Nettoyage du "flux" (suppression des messages traqués)
            const users = await getAllActiveUsers('telegram', 'user');

            // On traite par petits lots pour ne pas tout bloquer
            const BATCH_SIZE = 10;
            for (let i = 0; i < users.length; i += BATCH_SIZE) {
                const batch = users.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (user) => {
                    try {
                        if (user.data?.tracked_messages && user.data.tracked_messages.length > 0) {
                            const chatId = user.platform_id;
                            for (const msgId of user.data.tracked_messages) {
                                await bot.telegram.deleteMessage(chatId, msgId).catch(() => { });
                            }
                            await bot.telegram.sendMessage(chatId, "⏳ <b>Session expirée (6h)</b>\n\n➡ Veuillez taper /start pour continuer.", { parse_mode: 'HTML' }).catch(() => { });
                            await updateUserData(user.id, { tracked_messages: [] }).catch(() => { });
                        }
                    } catch (e) { }
                }));
                if (i + BATCH_SIZE < users.length) await new Promise(r => setTimeout(r, 1000));
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
