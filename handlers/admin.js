const { Markup } = require('telegraf');
const { broadcastMessage } = require('../services/broadcast');
const {
    getReferralLeaderboard, getGlobalStats, getAppSettings, updateAppSettings,
    getStatsOverview, getOrder, updateOrderStatus,
    getUserCount, getActiveUserCount, getRecentUsers,
    getAllOrders, searchUsers, searchLivreurs,
    getUser, setLivreurStatus, setLivreurAvailability, markUserBlocked,
    getProducts, saveProduct, getAllLivreurs, getOrderAnalytics
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
        return safeEdit(ctx, '❌ Mot de passe incorrect.');
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
        [Markup.button.callback('📊 Statistiques', 'admin_stats'), Markup.button.callback('📈 Analytiques', 'admin_analytics')],
        [Markup.button.callback('📦 Commandes Récentes', 'admin_orders')],
        [Markup.button.callback('🚴 Gestion Livreurs', 'admin_livreurs')],
        [Markup.button.callback('👥 Gestion Utilisateurs', 'admin_users')],
        [Markup.button.callback('🛒 Gestion Produits', 'admin_products')],
        [Markup.button.callback('📢 Diffusion Message', 'admin_broadcast')],
        [Markup.button.callback('⚙️ Paramètres', 'admin_settings')],
        [Markup.button.callback('◀️ Quitter la console', 'main_menu')]
    ]);

    if (isEdit) {
        return safeEdit(ctx, text, keyboard);
    } else {
        return safeEdit(ctx, text, keyboard);
    }
}

function setupAdminHandlers(bot) {

    // Commande /admin
    bot.command('admin', async (ctx) => {
        if (!(await isAdmin(ctx))) return safeEdit(ctx, '❌ Accès réservé.');
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            pendingAdminLogins.add(ctx.from.id);
            return safeEdit(ctx, '🔐 Veuillez entrer le mot de passe administrateur :');
        }
        return handleAdminLogin(ctx, args[1]);
    });

    bot.command('adduser', async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('❌ Usage: /adduser <TELEGRAM_ID>');

        const targetId = args[1];
        const { registerUser } = require('../services/database');

        try {
            await registerUser({ id: targetId, first_name: 'Utilisateur Manuel', username: 'inconnu' });
            ctx.reply(`✅ Utilisateur <code>${targetId}</code> ajouté manuellement avec succès !`, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply(`❌ Erreur : ${e.message}`);
        }
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
            `📍 Adresse : ${order.address || 'Non renseignée'}\n` +
            `💰 Total : ${order.total_price}€\n` +
            (order.livreur_name ? `🚴 Livreur : ${order.livreur_name}\n` : '') +
            `🔘 Statut : <b>${order.status.toUpperCase()}</b>`;

        const buttons = [
            [Markup.button.callback('🤝 ASSIGNER LIVREUR', `admin_order_assign_list_${orderId}`)],
            [Markup.button.callback('✅ LIVRÉE', `admin_order_set_${orderId}_delivered`), Markup.button.callback('❌ ANNULÉE', `admin_order_set_${orderId}_cancelled`)],
            [Markup.button.callback('◀️ Retour', 'admin_orders')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_assign_list_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const livreurs = await searchLivreurs('');
        const active = livreurs.filter(l => l.is_active && l.is_available);

        if (active.length === 0) return safeEdit(ctx, '❌ Aucun livreur disponible actuellement.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', `admin_order_view_${orderId}`)]]));

        const buttons = active.map(l => [Markup.button.callback(`🚴 ${l.first_name} (${l.current_city || '?'})`, `admin_order_do_assign_${orderId}_${l.id}`)]);
        buttons.push([Markup.button.callback('◀️ Annuler', `admin_order_view_${orderId}`)]);

        await safeEdit(ctx, `🤝 <b>Assignation manuelle</b>\n\nChoisissez le livreur pour la commande #${orderId.slice(-6)} :`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_do_assign_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, lid] = ctx.match;
        const livreur = await getUser(lid);
        if (!livreur) return ctx.answerCbQuery('❌ Erreur');

        const { assignOrderLivreur } = require('../services/database');
        await assignOrderLivreur(orderId, lid, livreur.first_name);

        await ctx.answerCbQuery(`✅ Assigné à ${livreur.first_name}`);
        // Notification au livreur
        bot.telegram.sendMessage(lid.replace('telegram_', ''), `🔔 <b>ADMIN : Une commande vous a été assignée !</b>\n\nRegardez vos commandes dans votre espace livreur.`).catch(() => { });

        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` } });
    });

    bot.action(/^admin_order_set_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, status] = ctx.match;
        await updateOrderStatus(orderId, status);
        await ctx.answerCbQuery(`✅ Statut mis à jour : ${status}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` } });
    });

    // Gestion des Utilisateurs
    bot.action('admin_users', async (ctx) => {
        await ctx.answerCbQuery();
        const users = await searchUsers('');
        const buttons = users.slice(0, 10).map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
        buttons.push([Markup.button.callback('🔍 Rechercher un utilisateur', 'admin_user_search')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, `👥 <b>Gestion des Utilisateurs</b>\n\nDerniers inscrits :`, Markup.inlineKeyboard(buttons));
    });

    const adminSearchState = new Map();
    bot.action('admin_user_search', async (ctx) => {
        await ctx.answerCbQuery();
        adminSearchState.set(ctx.from.id, true);
        await safeEdit(ctx, `🔍 <b>Recherche Utilisateur</b>\n\nEnvoyez le nom ou le @username de la personne :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_users')]]));
    });

    // On utilise un handler spécifique pour la recherche
    bot.on('text', async (ctx, next) => {
        if (adminSearchState.has(ctx.from.id)) {
            adminSearchState.delete(ctx.from.id);
            const query = ctx.message.text.trim();
            const users = await searchUsers(query);
            if (users.length === 0) return ctx.reply('❌ Aucun utilisateur trouvé.');

            const buttons = users.map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
            await ctx.reply(`🔍 <b>Résultats pour "${query}" :</b>`, Markup.inlineKeyboard(buttons));
            return;
        }
        await next();
    });

    bot.action(/^admin_user_view_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (!u) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `👤 <b>Profil de ${u.first_name}</b>\n\n` +
            `🆔 ID : <code>${u.id}</code>\n` +
            `💰 Solde : ${u.wallet_balance || 0}€\n` +
            `⭐️ Points : ${u.points || 0}\n` +
            `📦 Commandes : ${u.order_count || 0}\n` +
            `🚴 Est Livreur : ${u.is_livreur ? '✅ OUI' : '❌ NON'}`;

        const buttons = [
            [Markup.button.callback(u.is_livreur ? '🚫 Retirer Livreur' : '🚴 Passer Livreur', `admin_user_toggle_livreur_${u.id}`)],
            [Markup.button.callback(u.is_blocked ? '✅ Débloquer' : '🚫 Bloquer', `admin_user_block_${u.id}`)],
            [Markup.button.callback('◀️ Retour', 'admin_users')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_user_toggle_livreur_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (u) {
            const { supabase, COL_USERS } = require('../services/database');
            await supabase.from(COL_USERS).update({ is_livreur: !u.is_livreur }).eq('id', uid);
            await ctx.answerCbQuery(`✅ Changé !`);
            return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_user_view_${uid}` } });
        }
    });

    // Livreurs — vue détaillée avec actions
    bot.action('admin_livreurs', async (ctx) => {
        await ctx.answerCbQuery();
        const livreurs = await getAllLivreurs();
        if (livreurs.length === 0) return safeEdit(ctx, '🚴 Aucun livreur.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));

        let text = `🚴 <b>Gestion des Livreurs (${livreurs.length})</b>\n\n`;
        const buttons = livreurs.map(l => {
            const icon = l.is_available ? '🟢' : '🔴';
            return [Markup.button.callback(`${icon} ${l.first_name} — ${l.order_count || 0} livraisons`, `admin_livreur_view_${l.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_livreur_view_(.+)$/, async (ctx) => {
        const lid = ctx.match[1];
        const l = await getUser(lid);
        if (!l) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `🚴 <b>${l.first_name}</b> (@${l.username || '?'})\n\n` +
            `🆔 <code>${l.platform_id}</code>\n` +
            `🔘 Statut : ${l.is_available ? '🟢 DISPONIBLE' : '🔴 INDISPONIBLE'}\n` +
            `📦 Livraisons : ${l.order_count || 0}\n` +
            `💰 Solde : ${l.wallet_balance || 0}€`;

        const buttons = [
            [Markup.button.callback(l.is_available ? '🔴 Rendre Indisponible' : '🟢 Rendre Disponible', `admin_livreur_toggle_${lid}`)],
            [Markup.button.callback('🚫 Retirer statut livreur', `admin_user_toggle_livreur_${lid}`)],
            [Markup.button.callback('◀️ Retour', 'admin_livreurs')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_livreur_toggle_(.+)$/, async (ctx) => {
        const lid = ctx.match[1];
        const l = await getUser(lid);
        if (!l) return ctx.answerCbQuery('❌ Erreur');
        await setLivreurAvailability(lid, !l.is_available);
        await ctx.answerCbQuery(`✅ ${l.first_name} est maintenant ${!l.is_available ? 'disponible' : 'indisponible'}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_livreur_view_${lid}` } });
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

    // Broadcast — inline prompt
    const pendingBroadcasts = new Set();

    bot.action('admin_broadcast', async (ctx) => {
        await ctx.answerCbQuery();
        pendingBroadcasts.add(ctx.from.id);
        await safeEdit(ctx,
            `📢 <b>Diffusion de message</b>\n\n` +
            `Envoyez votre message maintenant dans le chat.\n` +
            `Il sera diffusé à tous les utilisateurs actifs.\n\n` +
            `<i>Ou utilisez /broadcast Votre Message</i>`,
            Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'admin_menu')]])
        );
    });

    bot.on('text', async (ctx, next) => {
        if (pendingBroadcasts.has(ctx.from.id) && authenticatedAdmins.has(ctx.from.id)) {
            pendingBroadcasts.delete(ctx.from.id);
            const msg = (ctx.message.text || '').trim();
            if (!msg) return safeEdit(ctx, '❌ Message vide.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_broadcast')]]));
            await safeEdit(ctx, '🚀 Diffusion en cours...');
            const res = await broadcastMessage('users', msg);
            return safeEdit(ctx, `✅ Diffusion terminée !\n\n📊 Cibles : ${res.total}\n✅ Succès : ${res.success}\n❌ Échecs : ${res.failed}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
        }
        return next();
    });

    bot.command('broadcast', async (ctx) => {
        if (!authenticatedAdmins.has(ctx.from.id)) return;
        const msg = ctx.message.text.split(' ').slice(1).join(' ');
        if (!msg) return safeEdit(ctx, '❌ Message vide. Usage: /broadcast Votre Message', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
        const res = await broadcastMessage('users', msg);
        await safeEdit(ctx, `✅ Diffusion terminée vers ${res.total} membres.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
    });

    // Bloquer un utilisateur
    bot.action(/^admin_user_block_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        await markUserBlocked(uid);
        await ctx.answerCbQuery('✅ Utilisateur bloqué');
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_user_view_${uid}` } });
    });

    // Paramètres — vue depuis Telegram
    bot.action('admin_settings', async (ctx) => {
        await ctx.answerCbQuery();
        const s = await getAppSettings();
        const msg = `⚙️ <b>Paramètres Actuels</b>\n\n` +
            `📛 Bot : ${s.bot_name}\n` +
            `🔑 Admin IDs : <code>${s.admin_telegram_id || 'Non défini'}</code>\n` +
            `🌐 Dashboard : ${s.dashboard_url || 'Non défini'}\n` +
            `📱 Contact : ${s.private_contact_url || 'Non défini'}\n` +
            `📢 Canal : ${s.channel_url || 'Non défini'}\n\n` +
            `⭐ Points/€ : ${s.points_ratio || 1}\n` +
            `🔄 Seuil conversion : ${s.points_exchange || 100} pts\n` +
            `💰 Valeur crédit : ${s.points_credit_value || 5}€\n` +
            `🎁 Bonus parrainage : ${s.ref_bonus || 5}€\n\n` +
            `<i>Pour modifier les paramètres, utilisez le dashboard web.</i>`;

        await safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    // Analytics rapide
    bot.action('admin_analytics', async (ctx) => {
        await ctx.answerCbQuery();
        const analytics = await getOrderAnalytics();

        const topProducts = Object.entries(analytics.byProduct || {})
            .sort((a, b) => b[1].qty - a[1].qty).slice(0, 5)
            .map(([name, d]) => `  • ${name} : ${d.qty} vendus (${d.ca.toFixed(2)}€)`).join('\n');

        const msg = `📈 <b>Analytiques</b>\n\n` +
            `💰 CA Total : <b>${analytics.totalCA.toFixed(2)}€</b>\n` +
            `📦 Commandes livrées : ${analytics.totalOrders}\n` +
            `⏱ Temps moyen : ${analytics.avgDeliveryTime} min\n\n` +
            (topProducts ? `🏆 <b>Top Produits :</b>\n${topProducts}` : '');

        await safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });
}

module.exports = { setupAdminHandlers };
