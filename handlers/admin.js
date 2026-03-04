const { Markup } = require('telegraf');
const { broadcastMessage } = require('../services/broadcast');
const {
    getReferralLeaderboard, getGlobalStats, getAppSettings,
    getStatsOverview, getOrder, updateOrderStatus,
    getUserCount, getActiveUserCount, getRecentUsers, db
} = require('../services/database');
require('dotenv').config();

const authenticatedAdmins = new Set();

async function isAdmin(ctx) {
    const settings = await getAppSettings();
    if (!settings.admin_telegram_id) return false;
    const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
    return adminIds.includes(String(ctx.from.id));
}

const pendingAdminLogins = new Set();

async function handleAdminLogin(ctx, password) {
    const settings = await getAppSettings();
    if (password === settings.admin_password) {
        authenticatedAdmins.add(ctx.from.id);
        return showAdminMenu(ctx);
    } else {
        return ctx.reply('❌ Mot de passe incorrect.');
    }
}

function setupAdminHandlers(bot) {

    // Commande /admin <password>
    bot.command('admin', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.reply('❌ Accès réservé à l\'administrateur.');
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            pendingAdminLogins.add(ctx.from.id);
            return ctx.reply('🔐 Veuillez entrer le mot de passe administrateur :');
        }
        const password = args[1];
        return handleAdminLogin(ctx, password);
    });

    // Action Menu Principal (depuis le bouton du bot)
    bot.action('admin_menu', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès refusé.');
        if (authenticatedAdmins.has(ctx.from.id)) {
            await ctx.answerCbQuery();
            return showAdminMenu(ctx, true);
        }
        pendingAdminLogins.add(ctx.from.id);
        await ctx.answerCbQuery();
        return ctx.reply('🔐 Pour accéder à la console, veuillez entrer le mot de passe administrateur :');
    });

    // Handler pour la saisie du mot de passe
    bot.on('text', async (ctx, next) => {
        if (!pendingAdminLogins.has(ctx.from.id)) return next();
        if (!(await isAdmin(ctx))) {
            pendingAdminLogins.delete(ctx.from.id);
            return next();
        }

        const password = ctx.message.text.trim();
        pendingAdminLogins.delete(ctx.from.id);
        return handleAdminLogin(ctx, password);
    });

    // Action Stats
    bot.action('admin_stats', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Session expirée.', { show_alert: true });
        await ctx.answerCbQuery();

        const stats = await getStatsOverview();
        const settings = await getAppSettings();
        const msg = `${settings.ui_icon_stats} <b>Statistiques en Temps Réel</b>\n\n` +
            `${settings.ui_icon_wallet} Total Ventes : <b>${stats.totalCA}€</b>\n` +
            `${settings.ui_icon_orders} Commandes : <b>${stats.totalOrders}</b>\n` +
            `👥 Membres : <b>${stats.totalUsers}</b>\n` +
            `${settings.ui_icon_livreur} Livreurs Actifs : <b>${stats.activeLivreurs} / ${stats.totalLivreurs}</b>\n\n` +
            `🎁 Parrainages : <b>${stats.totalStats.total_referrals || 0}</b>`;

        await ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]])
        });
    });

    // Action Commandes (Liste simple)
    bot.action('admin_orders', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Session expirée.', { show_alert: true });
        await ctx.answerCbQuery();

        const ordersSnap = await db.collection('orders').orderBy('created_at', 'desc').limit(10).get();
        if (ordersSnap.empty) {
            return ctx.editMessageText('📭 Aucune commande récente.', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]])
            });
        }

        const settings = await getAppSettings();
        const buttons = ordersSnap.docs.map(d => {
            const o = d.data();
            const statusIcon = o.status === 'delivered' ? settings.ui_icon_success : (o.status === 'pending' ? settings.ui_icon_pending : settings.ui_icon_error);
            return [Markup.button.callback(`${statusIcon} #${d.id.slice(-6)} | ${o.total_price}€ | ${o.first_name || 'Client'}`, `admin_order_view_${d.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);

        await ctx.editMessageText(`${settings.ui_icon_orders} <b>Dernières Commandes</b>\n\nCliquez sur une commande pour la gérer :`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action(/^admin_order_view_(.+)$/, async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Session expirée.', { show_alert: true });
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);

        if (!order) return ctx.editMessageText('❌ Commande non trouvée.');

        const settings = await getAppSettings();
        let msg = `${orderId.substring(0, 5)} <b>Détails Commande #${orderId.slice(-8)}</b>\n\n` +
            `👤 Client : <b>${order.first_name || 'Inconnu'}</b> (@${order.username || '?'})\n` +
            `${settings.ui_icon_catalog} Produit : <b>${order.product_name} (x${order.quantity})</b>\n` +
            `📍 Adresse : <b>${order.city}</b>\n` +
            `${settings.ui_icon_wallet} Total : <b>${order.total_price}€</b>\n` +
            `🔘 Statut : <b>${order.status.toUpperCase()}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const buttons = [
            [Markup.button.callback(`${settings.ui_icon_success} Passer en LIVRÉE`, `admin_order_status_${orderId}_delivered`)],
            [Markup.button.callback(`${settings.ui_icon_error} ANNULER la commande`, `admin_order_status_${orderId}_cancelled`)],
            [Markup.button.callback('◀️ Retour à la liste', 'admin_orders')]
        ];

        await ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action(/^admin_order_status_(.+)_(.+)$/, async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Session expirée.', { show_alert: true });
        const orderId = ctx.match[1];
        const newStatus = ctx.match[2];

        try {
            const order = await getOrder(orderId);
            if (!order) return ctx.answerCbQuery('❌ Commande non trouvée.');

            await updateOrderStatus(orderId, newStatus);
            await ctx.answerCbQuery(`✅ Statut mis à jour : ${newStatus.toUpperCase()}`);

            // Notification Client
            if (order.user_id && order.user_id.startsWith('telegram_')) {
                const tgId = order.user_id.replace('telegram_', '');
                let text = '';
                const shortId = orderId.substring(0, 5);
                const settings = await getAppSettings();
                if (newStatus === 'delivered') text = `${settings.ui_icon_success} <b>Commande #${shortId} ${settings.status_delivered_label} !</b>\n\nCelle-ci vient d'être marquée comme livrée. Merci de votre confiance et à bientôt ! 🚀`;
                else if (newStatus === 'cancelled') text = `${settings.ui_icon_error} <b>${settings.status_cancelled_label} de commande</b>\n\nVotre commande #${shortId} a été annulée par l'administration.`;

                if (text) ctx.telegram.sendMessage(tgId, text, { parse_mode: 'HTML' }).catch(() => { });
            }

            // Retourner aux détails
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` }
            });
        } catch (e) {
            console.error('Admin status update error:', e);
            await ctx.answerCbQuery('❌ Erreur lors de la mise à jour.');
        }
    });

    // Action Livreurs
    bot.action('admin_livreurs', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Session expirée.', { show_alert: true });
        await ctx.answerCbQuery();

        const livreursSnap = await db.collection('bot_users').where('is_livreur', '==', true).get();
        if (livreursSnap.empty) {
            return ctx.editMessageText('🚴 Aucun livreur enregistré.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
        }

        let msg = `🚴 <b>Gestion des Livreurs</b>\n\n`;
        livreursSnap.forEach(d => {
            const l = d.data();
            msg += `${l.is_available ? '🟢' : '⛔'} <b>${l.first_name || 'Inconnu'}</b> (@${l.username || l.platform_id})\n`;
        });

        await ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]])
        });
    });

    // Aide Admin (Rétrocompatibilité)
    bot.command('help', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.reply('/start — S\'inscrire');
        await ctx.replyWithHTML(
            `🛠 <b>Console Admin Telegram</b>\n\n` +
            `Utilisez <code>/admin &lt;password&gt;</code> pour ouvrir le menu interactif.\n\n` +
            `Commandes rapides :\n` +
            `/stats — Stats rapides\n` +
            `/users — Derniers inscrits\n` +
            `/broadcast &lt;all|tg&gt; &lt;msg&gt;`
        );
    });

    // Reste des commandes existantes
    bot.command('users', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.reply('❌ Accès refusé.');
        try {
            const users = await getRecentUsers(10);
            let message = `👥 <b>10 derniers inscrits :</b>\n\n`;
            users.forEach((u, i) => {
                message += `${i + 1}. 🤖 <b>${u.first_name || 'User'}</b>\n   ID: <code>${u.platform_id}</code>\n`;
            });
            await ctx.replyWithHTML(message);
        } catch (e) { ctx.reply('❌ Erreur users.'); }
    });

    bot.command('broadcast', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.reply('❌ Accès refusé.');
        const text = ctx.message.text.split(' ');
        if (text.length < 2) return ctx.reply('Usage: /broadcast <msg>');
        const message = text.slice(1).join(' ');
        await ctx.reply('📢 Envoi en cours...');
        const res = await broadcastMessage('telegram', message);
        await ctx.reply(`✅ Terminé ! Succès: ${res.success}, Échecs: ${res.failed}`);
    });
}

async function showAdminMenu(ctx, isEdit = false) {
    const settings = await getAppSettings();
    const msg = `🛠 <b>Console d'Administration</b>\n\n` +
        `Bienvenue dans l'interface de gestion. Vous pouvez tout piloter d'ici sans quitter Telegram.`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`${settings.ui_icon_stats} Statistiques & Reports`, 'admin_stats')],
        [Markup.button.callback(`${settings.ui_icon_orders} Commandes Récentes`, 'admin_orders')],
        [Markup.button.callback(`${settings.ui_icon_livreur} Gestion Livreurs`, 'admin_livreurs')],
        [Markup.button.callback(`${settings.ui_icon_broadcast} Lancer un Broadcast`, 'admin_broadcast_start')],
        [Markup.button.callback(`⚙️ Paramètres du Bot`, 'admin_settings')],
        [Markup.button.callback(`${settings.ui_icon_logout} Se déconnecter`, 'admin_logout')]
    ]);

    if (isEdit) {
        return ctx.editMessageText(msg, { parse_mode: 'HTML', ...keyboard });
    } else {
        return ctx.replyWithHTML(msg, keyboard);
    }
}

// Handler déconnexion
function setupExtendedHandlers(bot) {
    bot.action('admin_logout', async (ctx) => {
        authenticatedAdmins.delete(ctx.from.id);
        await ctx.answerCbQuery('🚪 Déconnecté.');
        return ctx.editMessageText('👋 Session admin terminée.');
    });

    bot.action('admin_broadcast_start', async (ctx) => {
        await ctx.answerCbQuery();
        return ctx.editMessageText('📢 Pour envoyer un message à tous, utilisez la commande :\n<code>/broadcast VOTRE MESSAGE</code>', {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]])
        });
    });

    bot.action('admin_settings', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        let msg = `⚙️ <b>Paramètres du Bot</b>\n\n`;
        msg += `🏷️ Nom Bot: <b>${settings.bot_name || 'Non défini'}</b>\n`;
        msg += `🔗 URL Dashboard: <code>${settings.dashboard_url || 'Non défini'}</code>\n`;
        msg += `🎁 Bonus Parrainage: <b>${settings.ref_bonus || 0}€</b>\n`;
        msg += `💳 Wallet Actif: <b>${settings.enable_wallet ? 'OUI' : 'NON'}</b>\n\n`;
        msg += `<i>Pour modifier ces paramètres ou les composants visuels (emojis, libellés), rendez-vous sur le Dashboard Web.</i>`;

        return ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]])
        });
    });
}

module.exports = {
    setupAdminHandlers: (bot) => {
        setupAdminHandlers(bot);
        setupExtendedHandlers(bot);
    }
};
