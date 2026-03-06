const { Markup } = require('telegraf');
const { broadcastMessage } = require('../services/broadcast');
const {
    getReferralLeaderboard, getGlobalStats, getAppSettings,
    getStatsOverview, getOrder, updateOrderStatus,
    getUserCount, getActiveUserCount, getRecentUsers,
    getAllOrders, searchUsers, searchLivreurs,
    getUser, setLivreurStatus, markUserBlocked,
    getProducts, saveProduct
} = require('../services/database');
const { safeEdit } = require('../services/utils');
require('dotenv').config();

const authenticatedAdmins = new Set();
const pendingAdminLogins = new Set();

async function isAdmin(ctx) {
    const settings = ctx.state.settings;
    if (!settings || !settings.admin_telegram_id) return false;
    const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
    return adminIds.includes(String(ctx.from.id));
}

async function handleAdminLogin(ctx, password) {
    const settings = ctx.state.settings;
    if (password === settings.admin_password || password === process.env.ADMIN_PASSWORD) {
        authenticatedAdmins.add(ctx.from.id);
        return showAdminMenu(ctx);
    } else {
        return ctx.reply('❌ Mot de passe incorrect.');
    }
}

async function showAdminMenu(ctx, isEdit = false) {
    const settings = await getAppSettings();
    const stats = await getStatsOverview();

    const text = `🛠 <b>Console d'Administration Telegram</b>\n\n` +
        `Bienvenue dans votre gestionnaire intégré.\n` +
        `Utilisateurs : <b>${stats.totalUsers}</b>\n` +
        `Ventes totales : <b>${stats.totalCA}€</b>\n\n` +
        `Choisissez une section pour gérer votre bot :`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 Statistiques Détaillées', 'admin_stats')],
        [Markup.button.callback('📦 Commandes Récentes', 'admin_orders')],
        [Markup.button.callback('🚴 Gestion Livreurs', 'admin_livreurs')],
        [Markup.button.callback('👥 Gestion Utilisateurs', 'admin_users')],
        [Markup.button.callback('🛒 Gestion Produits', 'admin_products')],
        [Markup.button.callback('📢 Diffusion Message', 'admin_broadcast')],
        [Markup.button.callback('◀️ Quitter la console', 'main_menu')]
    ]);

    if (isEdit) {
        return safeEdit(ctx, text, keyboard);
    } else {
        return ctx.replyWithHTML(text, keyboard);
    }
}

function setupAdminHandlers(bot) {

    // Commande /admin
    bot.command('admin', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.reply('❌ Accès réservé.');
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            pendingAdminLogins.add(ctx.from.id);
            return ctx.reply('🔐 Veuillez entrer le mot de passe administrateur :');
        }
        return handleAdminLogin(ctx, args[1]);
    });

    bot.action('admin_menu', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès refusé.');
        if (authenticatedAdmins.has(ctx.from.id)) {
            await ctx.answerCbQuery();
            return showAdminMenu(ctx, true);
        }
        pendingAdminLogins.add(ctx.from.id);
        await ctx.answerCbQuery();
        return ctx.reply('🔐 Veuillez entrer le mot de passe administrateur :');
    });

    // Handler texte (Pass et recherche)
    bot.on('text', async (ctx, next) => {
        if (pendingAdminLogins.has(ctx.from.id)) {
            pendingAdminLogins.delete(ctx.from.id);
            return handleAdminLogin(ctx, ctx.message.text.trim());
        }
        return next();
    });

    // --- SECTIONS ---

    // Stats
    bot.action('admin_stats', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Auth requise');
        await ctx.answerCbQuery();
        const stats = await getStatsOverview();
        const msg = `📊 <b>Statistiques Globales</b>\n\n` +
            `• Total CA : <b>${stats.totalCA}€</b>\n` +
            `• Commandes : <b>${stats.totalOrders}</b>\n` +
            `• Utilisateurs : <b>${stats.totalUsers}</b>\n` +
            `• Livreurs Actifs : <b>${stats.activeLivreurs}</b>\n` +
            `• Parrainages : <b>${stats.totalStats?.total_referrals || 0}</b>\n`;

        await safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    // Commandes
    bot.action('admin_orders', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return ctx.answerCbQuery('❌ Auth requise');
        await ctx.answerCbQuery();
        const orders = await getAllOrders(15);
        if (orders.length === 0) return safeEdit(ctx, '📭 Aucune commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));

        const buttons = orders.map(o => {
            const shortId = o.id.slice(-6);
            const icon = o.status === 'delivered' ? '✅' : (o.status === 'pending' ? '⏳' : '❌');
            return [Markup.button.callback(`${icon} #${shortId} - ${o.total_price}€ - ${o.first_name || 'Cl'}`, `admin_order_view_${o.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);

        await safeEdit(ctx, '📦 <b>Dernières Commandes</b>\nCliquez pour gérer :', Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_view_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        if (!order) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `📑 <b>Commande #${orderId.slice(-8)}</b>\n\n` +
            `👤 Client : ${order.first_name} (@${order.username})\n` +
            `🛒 Produit : ${order.product_name} x${order.quantity}\n` +
            `📍 Lieu : ${order.city}\n` +
            `💰 Total : ${order.total_price}€\n` +
            `🔘 Statut : <b>${order.status.toUpperCase()}</b>`;

        const buttons = [
            [Markup.button.callback('✅ LIVRÉE', `admin_order_set_${orderId}_delivered`), Markup.button.callback('❌ ANNULÉE', `admin_order_set_${orderId}_cancelled`)],
            [Markup.button.callback('◀️ Retour', 'admin_orders')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_set_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, status] = ctx.match;
        await updateOrderStatus(orderId, status);
        await ctx.answerCbQuery(`✅ Statut mis à jour : ${status}`);
        // Refresh view
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` } });
    });

    // Livreurs
    bot.action('admin_livreurs', async (ctx) => {
        await ctx.answerCbQuery();
        const livreurs = await searchLivreurs('');
        if (livreurs.length === 0) return safeEdit(ctx, '🚴 Aucun livreur.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));

        const list = livreurs.map(l => `${l.is_available ? '🟢' : '🔴'} ${l.first_name} (@${l.username || '?'})`).join('\n');
        await safeEdit(ctx, `🚴 <b>Liste des Livreurs</b>\n\n${list}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    // Produits
    bot.action('admin_products', async (ctx) => {
        await ctx.answerCbQuery();
        const products = await getProducts();
        const buttons = products.map(p => {
            return [Markup.button.callback(`${p.is_active ? '🟢' : '🔴'} ${p.name} - ${p.price}€`, `admin_prod_toggle_${p.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, `🛒 <b>Catalogue Produits</b>\nCliquez pour activer/désactiver :`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_prod_toggle_(.+)$/, async (ctx) => {
        const pid = ctx.match[1];
        const products = await getProducts();
        const p = products.find(x => x.id === pid);
        if (p) {
            await saveProduct({ ...p, is_active: !p.is_active });
            await ctx.answerCbQuery(`✅ ${p.name} est maintenant ${!p.is_active ? 'Actif' : 'Inactif'}`);
            // Refresh
            const updated = await getProducts();
            const buttons = updated.map(up => [Markup.button.callback(`${up.is_active ? '🟢' : '🔴'} ${up.name} - ${up.price}€`, `admin_prod_toggle_${up.id}`)]);
            buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
            await safeEdit(ctx, `🛒 <b>Catalogue Produits</b>`, Markup.inlineKeyboard(buttons));
        }
    });

    // Broadcast
    bot.action('admin_broadcast', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx, `📢 <b>Diffusion de message</b>\n\nPour envoyer un message à tous les utilisateurs :\nUtilisez la commande <code>/broadcast Votre Message</code>`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    bot.command('broadcast', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return;
        const msg = ctx.message.text.split(' ').slice(1).join(' ');
        if (!msg) return ctx.reply('❌ Message vide. Usage: /broadcast Hello');
        const res = await broadcastMessage(msg);
        ctx.reply(`🚀 Diffusion lancée vers ${res.total} membres.`);
    });
}

module.exports = { setupAdminHandlers };
