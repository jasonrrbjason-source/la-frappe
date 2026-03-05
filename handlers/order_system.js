const { Markup } = require('telegraf');
const {
    getProducts, createOrder, getUser, setLivreurStatus,
    updateLivreurPosition, getAvailableOrdersByCity, updateOrderStatus,
    getOrder, getAppSettings, getAllOrders, setLivreurAvailability,
    incrementOrderCount, getAvailableLivreurs, getLastMenuId
} = require('../services/database');
const { safeEdit, debugLog } = require('../services/utils');

function setupOrderSystem(bot) {
    // ========== CATALOGUE & COMMANDE ==========

    bot.action('view_catalog', async (ctx) => {
        await ctx.answerCbQuery();
        const products = await getProducts();
        const settings = ctx.state.settings;

        if (products.length === 0) {
            return safeEdit(ctx, '📭 Le catalogue est actuellement vide.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'main_menu')]]));
        }

        const buttons = products.map(p => {
            const uv = p.unit_value ? p.unit_value : '';
            const unitLabel = p.unit ? `/${uv}${p.unit}` : '';
            const promoLabel = p.promo ? ` 🔥${p.promo}` : '';
            return [Markup.button.callback(`${p.name} - ${p.price}€${unitLabel}${promoLabel}`, `buy_${p.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);

        await safeEdit(ctx,
            `${settings.ui_icon_catalog} <b>${settings.label_catalog}</b>\n\nChoisissez un produit pour commander :`,
            Markup.inlineKeyboard(buttons)
        );
    });

    // Sélection produit
    bot.action(/^buy_(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const productId = ctx.match[1];
            const products = await getProducts();
            const product = products.find(p => p.id === productId);

            if (!product) {
                debugLog(`[PRODUCT-ERR] ID ${productId} non trouvé.`);
                return safeEdit(ctx, '❌ Produit non trouvé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            }

            debugLog(`[PRODUCT-VIEW] ${product.name} par ${ctx.from.id}`);

            const uv = product.unit_value ? product.unit_value : '';
            const unitLabel = product.unit ? `/${uv}${product.unit}` : '';
            const promoText = product.promo ? `🎁 Promo : <b>${product.promo}</b>\n` : '';
            const settings = ctx.state.settings;
            let caption = `🛒 <b>${product.name}</b>\n` +
                `💰 Prix unité : <b>${product.price}€${unitLabel}</b>\n` +
                promoText + `\n` +
                `<b>${settings.msg_choose_qty}</b>`;

            // Telegram limit 1024
            if (caption.length > 1020) caption = caption.substring(0, 1017) + '...';

            const keyboard = Markup.inlineKeyboard([
                [1, 2, 3].map(q => Markup.button.callback(String(q), `qty_${productId}_${q}`)),
                [4, 5, 10].map(q => Markup.button.callback(String(q), `qty_${productId}_${q}`)),
                [Markup.button.callback('❌ Annuler', 'view_catalog')]
            ]);

            // Préparation des médias
            let productMedia = null;
            let productMediaGroup = null;
            const hasImage = product.image_url && typeof product.image_url === 'string' && product.image_url.length > 5;

            if (hasImage) {
                let mediaList = [];
                try {
                    if (product.image_url.startsWith('[') && product.image_url.endsWith(']')) {
                        mediaList = JSON.parse(product.image_url);
                    } else {
                        const isVideo = product.image_url.match(/\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i);
                        mediaList = [{ url: product.image_url, type: isVideo ? 'video' : 'photo' }];
                    }
                } catch (e) {
                    const isVideo = product.image_url.match(/\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i);
                    mediaList = [{ url: product.image_url, type: isVideo ? 'video' : 'photo' }];
                }

                mediaList = mediaList.filter(m => m.url && m.url.length > 5);

                if (mediaList.length > 1) {
                    productMediaGroup = mediaList.map(m => {
                        const url = typeof m === 'string' ? m : m.url;
                        const type = typeof m === 'object' ? m.type : null;
                        const isVideo = type === 'video' || url.match(/\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i);
                        return {
                            type: isVideo ? 'video' : 'photo',
                            media: url
                        };
                    });
                    keyboard.mediaGroup = productMediaGroup;
                } else if (mediaList.length === 1) {
                    const m = mediaList[0];
                    const url = typeof m === 'string' ? m : m.url;
                    const type = typeof m === 'object' ? m.type : null;
                    const isVideo = type === 'video' || url.match(/\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i);
                    const productMedia = url;

                    if (isVideo) {
                        keyboard.video = productMedia;
                    } else {
                        keyboard.photo = productMedia;
                    }
                    debugLog(`[PRODUCT-MEDIA] Envoi ${isVideo ? 'video' : 'photo'} pour ${product.name}`);
                }
            }

            await safeEdit(ctx, caption, keyboard);
        } catch (e) {
            debugLog(`[PRODUCT-FATAL] ${e.message}`);
            console.error('Error buy_', e);
        }
    });

    // Map temporaire pour stocker les infos en attente de saisie
    const pendingCityInput = new Map();
    const pendingOrderConfirmation = new Map();

    // Sélection Quantité -> demande d'adresse
    bot.action(/^qty_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const qty = parseInt(ctx.match[2]);
        const userId = `telegram_${ctx.from.id}`;

        const products = await getProducts();
        const product = products.find(p => p.id === productId);
        if (!product) return ctx.reply('❌ Produit non trouvé.');

        pendingCityInput.set(userId, { productId, qty, price: product.price, name: product.name });

        const settings = await getAppSettings();
        const text = `🛒 <b>${product.name}</b> (x${qty})\n` +
            `💰 Total : <b>${(product.price * qty).toFixed(2)}€</b>\n\n` +
            `🏠 <b>Veuillez maintenant envoyer votre adresse de livraison complète par message texte.</b>\n` +
            `<i>Ex: 12 rue de la Paix, 75000 Paris</i>`;

        let pickerUrl = '';
        if (settings.dashboard_url && settings.dashboard_url.includes('http')) {
            pickerUrl = settings.dashboard_url.replace(/\/dashboard\/?$/, '') + '/address-picker';
        }

        const buttons = [[Markup.button.callback('❌ Annuler', 'view_catalog')]];
        if (pickerUrl) {
            buttons.unshift([Markup.button.webApp("📍 Utiliser l'autocomplétion", pickerUrl)]);
        }

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });


    // ========== SYSTEME LIVREUR ==========

    bot.command('livreur_start', async (ctx) => {
        await setLivreurStatus(ctx.from.id, 'telegram', true);
        await safeEdit(ctx,
            '🚴 <b>Bienvenue dans l\'équipe de livraison !</b>\n\n' +
            'Vous êtes maintenant enregistré comme livreur.\n\n' +
            '<b>Utilisez le menu ci-dessous pour gérer vos livraisons :</b>',
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Livreur', 'livreur_menu')]])
        );
    });

    bot.command('dispo', async (ctx) => {
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return ctx.reply('❌ Vous n\'êtes pas livreur.');

        await ctx.replyWithHTML(
            `📢 <b>Statut actuel :</b> ${user.is_available ? '✅ DISPONIBLE' : '😴 INDISPONIBLE'}\n\n` +
            `Voulez-vous changer votre statut ?`,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ Passer en Disponible', 'set_dispo_true')],
                [Markup.button.callback('😴 Passer en Indisponible', 'set_dispo_false')],
                [Markup.button.callback('◀️ Menu', 'main_menu')]
            ])
        );
    });

    bot.action(/^set_dispo_(true|false)$/, async (ctx) => {
        const isAvailable = ctx.match[1] === 'true';
        await ctx.answerCbQuery(`Statut : ${isAvailable ? 'DISPONIBLE ✅' : 'INDISPONIBLE 😴'}`);

        await setLivreurAvailability(`telegram_${ctx.from.id}`, isAvailable);

        // Rafraîchir le menu livreur immédiatement (Dynamique)
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        const { getLivreurMenuKeyboard } = require('./start');

        const isAvail = user.is_available || (user.data && user.data.is_available);
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
            `👤 ${user.first_name}\n` +
            `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
            `🔘 Statut : <b>${isAvail ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const opts = { parse_mode: 'HTML', ...getLivreurMenuKeyboard(settings, user) };
        await safeEdit(ctx, text, opts);

        // Forcer la mise à jour du bouton de menu Telegram pour enlever le gros "Démarrer"
        ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });
    });

    bot.command('ma_position', async (ctx) => {
        const city = ctx.message.text.split(' ')[1];
        if (!city) return ctx.reply('❌ Usage: /ma_position [ville]');

        await updateLivreurPosition(`telegram_${ctx.from.id}`, city);
        await ctx.reply(`✅ Position mise à jour : ${city.toUpperCase()}`);
    });

    bot.command('commandes_ville', async (ctx) => {
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return ctx.reply('❌ Vous n\'êtes pas livreur.');
        if (!user.current_city) return ctx.reply('❌ Définissez votre ville d\'abord avec /ma_position [ville]');

        const orders = await getAvailableOrdersByCity(user.current_city);
        if (orders.length === 0) return ctx.reply(`📭 Aucune commande en attente à ${user.current_city.toUpperCase()}.`);

        let text = `📦 <b>Commandes à ${user.current_city.toUpperCase()} :</b>\n\n`;
        const buttons = orders.map(o => [
            Markup.button.callback(`Prendre #${o.id.substring(0, 5)} - ${o.total_price}€`, `take_${o.id}`)
        ]);

        await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^take_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);

        if (!order || order.status !== 'pending') {
            return safeEdit(ctx, '❌ Commande déjà prise ou inexistante.', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]])
            }).catch(() => ctx.reply('❌ Commande déjà prise ou inexistante.'));
        }

        await updateOrderStatus(orderId, 'taken', {
            livreur_id: `telegram_${ctx.from.id}`,
            livreur_name: ctx.from.first_name
        });

        const settings = await getAppSettings();
        await safeEdit(ctx,
            `${settings.ui_icon_success} <b>Commande #${orderId.substring(0, 5)} acceptée !</b>\n\n` +
            `📍 Ville : ${order.city}\n` +
            `👤 Client : ${order.first_name} (@${order.username})\n\n` +
            `💡 <i>Pensez à partager votre position en direct pour notifier le client de votre arrivée.</i>\n\n` +
            `Cliquez sur le bouton ci-dessous une fois livré :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏰ Arrivée -1h', `notify_${orderId}_1h`)],
                    [Markup.button.callback('⏳ 30 min', `notify_${orderId}_30m`), Markup.button.callback('⏳ 10 min', `notify_${orderId}_10m`)],
                    [Markup.button.callback('⚡ 5 min', `notify_${orderId}_5m`), Markup.button.callback('📍 Arrivé', `notify_${orderId}_here`)],
                    [Markup.button.callback(`${settings.ui_icon_success} MARQUER COMME LIVRÉE`, `finish_${orderId}`)],
                    [Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]
                ])
            }
        ).catch(() => { });

        // Notifier le client
        bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
            `🚚 <b>Bonne nouvelle !</b>\n\n` +
            `Votre commande #${orderId.substring(0, 5)} est prise en charge par <b>La Frappe</b>.\n` +
            `⏳ Une estimation du temps d'arrivé vous sera donnée dans quelques minutes.\n\n` +
            `<i>Préparez l'appoint pour le paiement en liquide.</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => { });
    });

    bot.action(/^notify_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Notification envoyée ✅');
        const orderId = ctx.match[1];
        const timeCode = ctx.match[2];
        const order = await getOrder(orderId);
        if (!order) return;

        let timeText = "";
        if (timeCode === '1h') timeText = "⏰ dans - d'1h";
        else if (timeCode === '30m') timeText = "⏳ dans 30 min";
        else if (timeCode === '10m') timeText = "⏳ dans 10 min";
        else if (timeCode === '5m') timeText = "⚡ dans 5 min";
        else if (timeCode === 'here') timeText = "📍 Suis arrivé, descends";

        bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
            `🔔 <b>Mise à jour Livraison #${orderId.substring(0, 5)}</b>\n\n` +
            `Votre livreur vous informe qu'il arrive : <b>${timeText}</b>\n\n` +
            `<i>Restez joignable !</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => { });
    });

    bot.action(/^finish_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        const settings = await getAppSettings();

        await updateOrderStatus(orderId, 'delivered');
        await safeEdit(ctx, `${settings.ui_icon_success || '✅'} <b>Commande #${orderId.substring(0, 5)} terminée !</b>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Espace Livreur', 'livreur_menu')]])
        }).catch(() => { });

        // Notifier client (fallback text, usually replaced by the central notification system in API, but kept here just in case)
        if (order && order.user_id) {
            bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
                `${settings.ui_icon_success || '✅'} <b>Commande livrée !</b>\n\n` +
                `Merci d'avoir commandé chez nous. À bientôt !`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Base', 'main_menu')]]) }
            ).catch(() => { });
        }
    });

    bot.command('livree', async (ctx) => {
        const orderId = ctx.message.text.split(' ')[1];
        if (!orderId) return ctx.reply('❌ Usage: /livree [ID_COMMANDE]');

        const order = await getOrder(orderId);
        if (!order) return ctx.reply('❌ Commande non trouvée.');

        await updateOrderStatus(orderId, 'delivered');
        await safeEdit(ctx, '✅ Livraison confirmée. Merci pour votre travail !', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'livreur_menu')]]));

        // Notifier client
        bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
            `✅ <b>Commande livrée !</b>\n\n` +
            `Merci d'avoir commandé chez nous. À bientôt !`,
            { parse_mode: 'HTML' }
        ).catch(() => { });
    });

    bot.action('livreur_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return safeEdit(ctx, '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const { getLivreurMenuKeyboard } = require('./start');
        const isAvail = user.is_available || (user.data && user.data.is_available);
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
            `👤 ${user.first_name}\n` +
            `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
            `🔘 Statut : <b>${isAvail ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;
        const opts = { parse_mode: 'HTML', ...getLivreurMenuKeyboard(settings, user) };

        try {
            await safeEdit(ctx, text, opts);
        } catch (e) {
            await ctx.replyWithHTML(text, getLivreurMenuKeyboard(settings, user));
        }
    });

    // Mode client pour les livreurs
    bot.action('client_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        await safeEdit(ctx,
            `🛒 <b>Mode Client</b>\n\nVous pouvez commander comme un client normal :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`${settings.ui_icon_catalog} ${settings.label_catalog}`, 'view_catalog')],
                    [Markup.button.callback(`${settings.ui_icon_orders} ${settings.label_my_orders}`, 'my_orders')],
                    [Markup.button.callback(`${settings.ui_icon_profile} ${settings.label_profile}`, 'my_referrals')],
                    [Markup.button.callback(`${settings.ui_icon_livreur} Retour ${settings.label_livreur_space}`, 'livreur_menu')]
                ])
            }
        );
    });

    bot.action('show_city_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return ctx.reply('❌ Accès refusé.');

        // Si pas de ville → montrer toutes les commandes en attente
        let orders;
        let title;
        if (user.current_city) {
            orders = await getAvailableOrdersByCity(user.current_city);
            title = `📦 <b>Commandes à ${user.current_city.toUpperCase()} :</b>`;
        } else {
            // Récupérer toutes les commandes pending
            const allOrders = await getAllOrders(20);
            orders = allOrders.filter(o => o.status === 'pending');
            title = `📦 <b>Toutes les commandes en attente :</b>\n\n<i>⚠️ Définissez votre secteur pour filtrer les commandes proches.</i>`;
        }

        if (orders.length === 0) {
            return ctx.replyWithHTML(
                `📭 Aucune commande en attente.`,
                Markup.inlineKeyboard([[Markup.button.callback('🔄 Rafraîchir', 'show_city_orders')], [Markup.button.callback('◀️ Retour', 'livreur_menu')]])
            );
        }

        const buttons = orders.map(o => [
            Markup.button.callback(
                `📍 ${o.first_name || 'Client'} | ${(o.city || 'N/A').substring(0, 25)} | ${o.total_price}€`,
                `take_${o.id}`
            )
        ]);
        buttons.push([Markup.button.callback('🔄 Rafraîchir', 'show_city_orders')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, title, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    // Historique des livraisons du livreur
    bot.action('my_deliveries', async (ctx) => {
        await ctx.answerCbQuery();
        const { getLivreurHistory } = require('../services/database');
        const livreurId = `telegram_${ctx.from.id}`;
        const myDelivered = await getLivreurHistory(livreurId);

        if (myDelivered.length === 0) {
            return ctx.replyWithHTML(
                `📊 <b>Historique Livraisons</b>\n\nVous n'avez pas encore effectué de livraison.`,
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]])
            );
        }

        const today = new Date().toISOString().split('T')[0];
        const thisMonth = new Date().toISOString().substring(0, 7);

        const statsToday = myDelivered.filter(o => o.created_at && new Date(o.created_at).toISOString().split('T')[0] === today);
        const statsMonth = myDelivered.filter(o => o.created_at && new Date(o.created_at).toISOString().substring(0, 7) === thisMonth);

        const caToday = statsToday.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0);
        const caMonth = statsMonth.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0);
        const caTotal = myDelivered.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0);

        let text = `📊 <b>Mes Statistiques Gains</b>\n\n`;
        text += `📅 <b>Aujourd'hui :</b>\n`;
        text += `   • Courses : <b>${statsToday.length}</b>\n`;
        text += `   • Gains : <b>${caToday.toFixed(2)}€</b>\n\n`;

        text += `🗓️ <b>Ce Mois (${thisMonth}) :</b>\n`;
        text += `   • Courses : <b>${statsMonth.length}</b>\n`;
        text += `   • Gains : <b>${caMonth.toFixed(2)}€</b>\n\n`;

        text += `🏆 <b>Total Historique :</b>\n`;
        text += `   • Courses livrées : <b>${myDelivered.length}</b>\n`;
        text += `   • Total Gain : <b>${caTotal.toFixed(2)}€</b>\n\n`;

        const takenCount = myDeliveries.filter(o => o.status === 'taken').length;
        if (takenCount > 0) text += `⏳ <i>Livraison(s) en cours : ${takenCount}</i>\n`;

        await safeEdit(ctx, text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]])
        });
    });

    bot.action('my_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const orders = await getAllOrders(10);
        const myOrders = orders.filter(o => o.user_id === `telegram_${ctx.from.id}`);

        if (myOrders.length === 0) {
            return safeEdit(ctx, '📭 Vous n\'avez pas encore passé de commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }

        let text = `${settings.ui_icon_orders || '📦'} <b>Mes dernières commandes :</b>\n\n`;
        myOrders.forEach(o => {
            const statusIcon = o.status === 'delivered' ? (settings.ui_icon_success || '✅') : (o.status === 'pending' ? (settings.ui_icon_pending || '⏳') : (settings.ui_icon_error || '❌'));
            const statusLabel = o.status === 'delivered' ? (settings.status_delivered_label || 'LIVRÉE') : (o.status === 'pending' ? (settings.status_pending_label || 'EN ATTENTE') : (o.status === 'taken' ? (settings.status_taken_label || 'EN COURS') : (settings.status_cancelled_label || 'ANNULÉE')));

            text += `🔹 ${o.product_name} x${o.quantity} — ${o.total_price}€\n`;
            text += `├ Statut : ${statusIcon} <b>${statusLabel}</b>\n`;
            text += `└ ${o.city || 'Adresse non définie'}\n\n`;
        });

        await safeEdit(ctx, text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]])
        });
    });

    // Map temporaire pour les livreurs qui changent de secteur
    const pendingCityChange = new Map();

    bot.action('change_city', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        pendingCityChange.set(userId, true);
        await safeEdit(ctx,
            '📍 <b>Changer de secteur</b>\n\n' +
            '✍️ Tapez vos <b>villes ou secteurs</b> séparés par une virgule :\n' +
            '<i>Ex: Vitry, Ivry, Thiais, Paris 13</i>',
            Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'livreur_menu')]])
        );
    });

    // ========== GESTION TEXTE LIBRE (adresse livraison + changement secteur livreur) ==========
    bot.on('message', async (ctx) => {
        const userId = `telegram_${ctx.from.id}`;
        let inputText = '';
        if (ctx.message && ctx.message.web_app_data && ctx.message.web_app_data.data) {
            inputText = ctx.message.web_app_data.data.trim();
        } else if (ctx.message && ctx.message.text) {
            inputText = ctx.message.text.trim();
        } else return;

        // Auto-delete message for cleaner UI (Flow Constant)
        ctx.deleteMessage().catch(() => { });

        if (inputText === '❌ Annuler la commande' || inputText.toLowerCase() === 'annuler') {
            pendingCityInput.delete(userId);
            pendingCityChange.delete(userId);
            return safeEdit(ctx, '❌ Action annulée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }

        // Si le livreur change de secteur
        if (pendingCityChange.has(userId)) {
            pendingCityChange.delete(userId);
            const city = inputText.replace(/<[^>]*>/g, '').trim();
            if (city.length < 2) {
                pendingCityChange.set(userId, true);
                return safeEdit(ctx, '❌ Nom de ville trop court. Réessayez :', Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'livreur_menu')]]));
            }
            await updateLivreurPosition(userId, city);
            return safeEdit(ctx, `✅ Secteur mis à jour : <b>${city.toUpperCase()}</b>`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Espace Livreur', 'livreur_menu')]]));
        }

        // Si l'utilisateur est en attente de saisie d'adresse de livraison
        if (pendingCityInput.has(userId)) {
            const { productId, qty } = pendingCityInput.get(userId);
            const address = inputText.replace(/<[^>]*>/g, '').trim();

            if (address.length < 8) {
                return safeEdit(ctx, `❌ <b>Adresse incomplète.</b>\nPrécisez numéro, rue et ville.\nEx: 15 rue de la Paix, 75001 Paris`, Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'view_catalog')]]));
            }

            try {
                const user = await getUser(userId);
                const settings = await getAppSettings();
                const products = await getProducts();
                const product = products.find(p => p.id === productId);
                if (!product) return safeEdit(ctx, '❌ Produit non trouvé.', Markup.inlineKeyboard([[Markup.button.callback('🍔 Catalogue', 'view_catalog')]]));

                const totalPriceRaw = product.price * qty;

                // SI CRÉDIT DISPONIBLE → ON DEMANDE (En respectant la règle de fidélité)
                if (user && user.wallet_balance > 0) {
                    const maxPct = settings.fidelity_wallet_max_pct || 50;
                    const minSpend = settings.fidelity_min_spend || 0;

                    const maxAllowedCredit = (totalPriceRaw * maxPct) / 100;
                    const possibleDiscount = Math.min(maxAllowedCredit, user.wallet_balance);

                    if (totalPriceRaw >= minSpend && possibleDiscount > 0) {
                        pendingOrderConfirmation.set(userId, { productId, qty, address, totalPriceRaw });
                        return safeEdit(ctx,
                            `💰 <b>Utiliser votre solde ?</b>\n\n` +
                            `Votre solde actuel : <b>${(user.wallet_balance).toFixed(2)}€</b>\n` +
                            `Règle de fidélité : Vous pouvez utiliser jusqu'à <b>${maxPct}%</b> du panier (soit <b>${possibleDiscount.toFixed(2)}€</b>).\n\n` +
                            `Voulez-vous appliquer cette réduction ?`,
                            Markup.inlineKeyboard([
                                [Markup.button.callback(`✅ Oui, déduire ${possibleDiscount.toFixed(2)}€`, 'confirm_order_use_credit_yes')],
                                [Markup.button.callback('❌ Non, payer plein tarif', 'confirm_order_use_credit_no')],
                                [Markup.button.callback('🚫 Annuler commande', 'view_catalog')]
                            ])
                        );
                    }
                }

                // PAS DE CRÉDIT or rule not met → CRÉATION DIRECTE
                await finalizeOrderCreation(ctx, userId, product, qty, address, settings, 0);
            } catch (err) {
                console.error('[ORDER] Error:', err);
                await safeEdit(ctx, '❌ Erreur lors de la validation.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'view_catalog')]]));
            }
        }
    });

    // Confirmation avec crédit
    bot.action('confirm_order_use_credit_yes', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const user = await getUser(userId);
        const settings = await getAppSettings();
        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);

        const maxPct = settings.fidelity_wallet_max_pct || 50;
        const maxAllowedCredit = (pending.totalPriceRaw * maxPct) / 100;
        const discount = Math.min(maxAllowedCredit, user.wallet_balance);

        // Déduire crédit
        const { supabase, COL_USERS } = require('../services/database');
        await supabase.from(COL_USERS).update({ wallet_balance: user.wallet_balance - discount }).eq('id', userId);

        await finalizeOrderCreation(ctx, userId, product, pending.qty, pending.address, settings, discount);
        pendingOrderConfirmation.delete(userId);
    });

    bot.action('confirm_order_use_credit_no', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const settings = await getAppSettings();
        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);

        await finalizeOrderCreation(ctx, userId, product, pending.qty, pending.address, settings, 0);
        pendingOrderConfirmation.delete(userId);
    });

    async function finalizeOrderCreation(ctx, userId, product, qty, address, settings, discount) {
        const finalPrice = (product.price * qty) - discount;
        const discountText = discount > 0 ? `\n🎁 Réduction : -${discount.toFixed(2)}€` : "";

        const orderId = await createOrder({
            user_id: userId,
            username: ctx.from.username || null,
            first_name: ctx.from.first_name || 'Client',
            product_name: product.name,
            quantity: qty,
            total_price: finalPrice,
            city: address,
            platform: 'telegram',
            discount_applied: discount,
            status: 'pending'
        });

        pendingCityInput.delete(userId);

        const finalMsg = `${settings.msg_order_success || '✅ Commande enregistrée !'}\n\n` +
            `📦 Produit : <b>${product.name} (x${qty})</b>\n` +
            `📍 Adresse : <i>${address}</i>${discountText}\n` +
            `💰 Total : <b>${finalPrice.toFixed(2)}€</b>\n\n` +
            `${settings.msg_search_livreur || '⏳ Recherche d\'un livreur...'}`;

        await safeEdit(ctx, finalMsg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const notificationText = `🔔 <b>Nouvelle Commande !</b>\n\n` +
            `📦 ${product.name} x${qty}\n📍 <b>${address.toUpperCase()}</b>\n💰 Total : <b>${finalPrice.toFixed(2)}€</b>`;

        const { getAvailableLivreurs } = require('../services/database');
        const availableLivreurs = await getAvailableLivreurs();
        availableLivreurs.forEach(livreur => {
            const tid = livreur.platform_id;
            if (tid) {
                bot.telegram.sendMessage(tid, notificationText, Markup.inlineKeyboard([[Markup.button.callback('🚴 Prendre la commande', `take_${orderId}`)]])).catch(() => { });
            }
        });
    }

    // ========== TRACKING & PROXIMITÉ ==========
    function getDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    async function handleLivreurTracking(botInstance, livreurId, loc) {
        try {
            const { getLivreurOrders, getUser, db } = require('../services/database');
            const activeOrders = await getLivreurOrders(livreurId);
            if (activeOrders.length === 0) return;

            for (const order of activeOrders) {
                const client = await getUser(order.user_id);
                if (!client || !client.latitude || !client.longitude) continue;

                const dist = getDistance(loc.latitude, loc.longitude, client.latitude, client.longitude);
                if (dist <= 1.5 && !order.notified_5m) {
                    await botInstance.telegram.sendMessage(order.user_id.replace('telegram_', ''),
                        `🚀 <b>Votre livreur est à moins de 5 minutes !</b>\nMerci de vous préparer à sortir pour la réception.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => { });
                    const { supabase } = require('../config/supabase');
                    await supabase.from('bot_orders').update({ notified_5m: true, notified_10m: true }).eq('id', order.id);
                } else if (dist <= 4.0 && !order.notified_10m && !order.notified_5m) {
                    await botInstance.telegram.sendMessage(order.user_id.replace('telegram_', ''),
                        `🚚 <b>Votre livreur arrive dans environ 10 minutes.</b>\nPréparez-vous à sortir bientôt !`,
                        { parse_mode: 'HTML' }
                    ).catch(() => { });
                    const { supabase } = require('../config/supabase');
                    await supabase.from('bot_orders').update({ notified_10m: true }).eq('id', order.id);
                }
            }
        } catch (e) {
            console.error('[TRACKING] Error:', e.message);
        }
    }

    bot.on('location', async (ctx) => {
        const userId = `telegram_${ctx.from.id}`;
        const loc = ctx.message.location;
        const { saveUserLocation } = require('../services/database');
        await saveUserLocation(userId, loc.latitude, loc.longitude).catch(() => { });
        await handleLivreurTracking(bot, userId, loc);
    });

    bot.on('edited_message', async (ctx) => {
        if (ctx.editedMessage.location) {
            const userId = `telegram_${ctx.from.id}`;
            const loc = ctx.editedMessage.location;
            const { saveUserLocation } = require('../services/database');
            await saveUserLocation(userId, loc.latitude, loc.longitude).catch(() => { });
            await handleLivreurTracking(bot, userId, loc);
        }
    });
}

module.exports = { setupOrderSystem };
