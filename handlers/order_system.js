const { Markup } = require('telegraf');
const {
    getProducts, createOrder, getUser, setLivreurStatus,
    updateLivreurPosition, getAvailableOrdersByCity, updateOrderStatus,
    getOrder, getAppSettings, getAllOrders, setLivreurAvailability,
    incrementOrderCount, getAvailableLivreurs
} = require('../services/database');

// Helper: essaye d'éditer le message, sinon envoie un nouveau
async function safeEdit(ctx, text, opts) {
    try {
        await safeEdit(ctx, text, opts);
    } catch (e) {
        await ctx.replyWithHTML(text, opts.reply_markup ? { reply_markup: opts.reply_markup } : undefined);
    }
}

function setupOrderSystem(bot) {
    // ========== CATALOGUE & COMMANDE ==========

    bot.action('view_catalog', async (ctx) => {
        await ctx.answerCbQuery();
        const products = await getProducts();

        if (products.length === 0) {
            return ctx.reply('📭 Le catalogue est actuellement vide.');
        }

        const buttons = products.map(p => [
            Markup.button.callback(`${p.name} - ${p.price}€`, `buy_${p.id}`)
        ]);
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);

        const settings = await getAppSettings();
        await safeEdit(ctx, 
            `${settings.ui_icon_catalog} <b>${settings.label_catalog}</b>\n\nChoisissez un produit pour commander :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            }
        );
    });

    // Sélection produit
    bot.action(/^buy_(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const productId = ctx.match[1];
            const products = await getProducts();
            const product = products.find(p => p.id === productId);

            if (!product) return ctx.reply('❌ Produit non trouvé.');

            const promoText = product.promo ? `🎁 Promo : <b>${product.promo}</b>\n` : '';
            const settings = await getAppSettings();
            const caption = `🛒 <b>${product.name}</b>\n` +
                `💰 Prix unité : <b>${product.price}€</b>\n` +
                promoText + `\n` +
                `<b>${settings.msg_choose_qty}</b>`;

            const keyboard = Markup.inlineKeyboard([
                [1, 2, 3].map(q => Markup.button.callback(String(q), `qty_${productId}_${q}`)),
                [4, 5, 10].map(q => Markup.button.callback(String(q), `qty_${productId}_${q}`)),
                [Markup.button.callback('❌ Annuler', 'view_catalog')]
            ]);

            if (product.image_url) {
                let mediaList = [];
                try {
                    // Verifier si c'est du JSON (multiple)
                    if (product.image_url.startsWith('[')) {
                        mediaList = JSON.parse(product.image_url);
                    } else {
                        const type = product.image_url.match(/\.(mp4|webm|mov)(\?.*)?$/i) ? 'video' : 'photo';
                        mediaList = [{ url: product.image_url, type }];
                    }
                } catch (e) {
                    const type = product.image_url.match(/\.(mp4|webm|mov)(\?.*)?$/i) ? 'video' : 'photo';
                    mediaList = [{ url: product.image_url, type }];
                }

                if (mediaList.length > 1) {
                    // Plusieurs médias : Envoi en MediaGroup
                    const telegramMedia = mediaList.map((m, index) => {
                        const isLocal = m.url.startsWith('/public/');
                        const media = isLocal
                            ? { source: require('path').join(__dirname, '..', 'web', m.url) }
                            : m.url;
                        return {
                            type: m.type === 'video' ? 'video' : 'photo',
                            media: media,
                            caption: index === 0 ? caption : undefined,
                            parse_mode: index === 0 ? 'HTML' : undefined
                        };
                    });

                    await ctx.replyWithMediaGroup(telegramMedia).catch(e => console.error("MediaGroup Error:", e));
                    await ctx.replyWithHTML('🔽 <b>Choisissez votre quantité :</b>', keyboard);
                } else {
                    // Un seul média : Garde le comportement original
                    const m = mediaList[0];
                    const isLocal = m.url.startsWith('/public/');
                    const urlObj = isLocal
                        ? { source: require('path').join(__dirname, '..', 'web', m.url) }
                        : m.url;

                    if (m.type === 'video') {
                        await ctx.replyWithVideo(urlObj, { caption: caption, parse_mode: 'HTML', ...keyboard })
                            .catch(e => ctx.replyWithHTML(caption, keyboard));
                    } else {
                        await ctx.replyWithPhoto(urlObj, { caption: caption, parse_mode: 'HTML', ...keyboard })
                            .catch(e => ctx.replyWithHTML(caption, keyboard));
                    }
                }
            } else {
                await ctx.replyWithHTML(caption, keyboard);
            }
        } catch (e) {
            console.error('Fatal action error on buy_', e);
            try { await ctx.reply("❌ Une erreur s'est produite lors du chargement du produit."); } catch (err) { }
        }
    });

    // Map temporaire pour stocker les infos en attente de saisie de ville
    const pendingCityInput = new Map();

    // Sélection Quantité -> demande d'adresse directement
    bot.action(/^qty_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const qty = parseInt(ctx.match[2]);
        const userId = `telegram_${ctx.from.id}`;
        pendingCityInput.set(userId, { productId, qty });

        const settings = await getAppSettings();
        let pickerUrl = '';
        if (settings.dashboard_url && settings.dashboard_url.includes('http')) {
            pickerUrl = settings.dashboard_url.replace(/\/dashboard\/?$/, '') + '/address-picker';
        }

        if (pickerUrl) {
            await ctx.replyWithHTML(
                '📍 <b>Adresse de livraison</b>\n\n' +
                '✍️ Veuillez utiliser notre système de suggestion d\'adresse ci-dessous (recommandé) ou taper votre adresse manuellement :',
                Markup.keyboard([
                    [Markup.button.webApp("📍 Utiliser l'autocomplétion", pickerUrl)],
                    ["❌ Annuler la commande"]
                ]).resize().oneTime()
            );
        } else {
            await ctx.replyWithHTML(
                '📍 <b>Adresse de livraison</b>\n\n' +
                '✍️ Tapez votre <b>adresse complète</b> (numéro, rue, code postal, ville) :',
                Markup.keyboard([["❌ Annuler la commande"]]).resize().oneTime()
            );
        }
    });


    // ========== SYSTEME LIVREUR ==========

    bot.command('livreur_start', async (ctx) => {
        await setLivreurStatus(ctx.from.id, 'telegram', true);
        await ctx.replyWithHTML(
            '🚴 <b>Bienvenue dans l\'équipe de livraison !</b>\n\n' +
            'Vous êtes maintenant enregistré comme livreur.\n\n' +
            '<b>Commandes :</b>\n' +
            '1. /dispo - Pour indiquer si vous êtes prêt à livrer\n' +
            '2. /ma_position [ville] - Pour vous localiser\n' +
            '3. /commandes_ville - Pour voir les livraisons'
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
        await ctx.answerCbQuery();
        const isAvailable = ctx.match[1] === 'true';
        await setLivreurAvailability(`telegram_${ctx.from.id}`, isAvailable);
        const settings = await getAppSettings();
        await safeEdit(ctx, 
            `${settings.ui_icon_notification} <b>Statut mis à jour :</b> ${isAvailable ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]]) }
        );
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

        // Calcul temps estimé (algo simple)
        const min = 15 + Math.floor(Math.random() * 30);

        const settings = await getAppSettings();
        await safeEdit(ctx, 
            `${settings.ui_icon_success} <b>Commande #${orderId.substring(0, 5)} acceptée !</b>\n\n` +
            `📍 Ville : ${order.city}\n` +
            `👤 Client : ${order.first_name} (@${order.username})\n\n` +
            `Cliquez sur le bouton ci-dessous une fois livré :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback(`${settings.ui_icon_success} MARQUER COMME LIVRÉE`, `finish_${orderId}`)]])
            }
        ).catch(() => { });

        // Notifier le client
        bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
            `🚚 <b>Bonne nouvelle !</b>\n\n` +
            `Votre commande #${orderId.substring(0, 5)} est prise en charge par <b>${ctx.from.first_name}</b>.\n` +
            `⏳ Arrivée estimée : <b>${min} minutes</b>.\n\n` +
            `<i>Préparez l'appoint pour le paiement en liquide.</i>`,
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
        await ctx.reply('✅ Livraison confirmée. Merci pour votre travail !');

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
        if (!user || !user.is_livreur) return ctx.reply('❌ Accès refusé.');

        const { getLivreurMenuKeyboard } = require('./start');
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
            `👤 ${user.first_name}\n` +
            `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
            `🔘 Statut : <b>${user.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
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
                `📍 #${o.id.substring(0, 5)} | ${o.product_name} x${o.quantity} | ${o.total_price}€`,
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
        const livreurId = `telegram_${ctx.from.id}`;
        const allOrders = await getAllOrders(50);
        const myDeliveries = allOrders.filter(o => o.livreur_id === livreurId);

        if (myDeliveries.length === 0) {
            return ctx.replyWithHTML(
                `📊 <b>Historique Livraisons</b>\n\nVous n'avez pas encore effectué de livraison.`,
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]])
            );
        }

        const today = new Date().toISOString().split('T')[0];
        const thisMonth = new Date().toISOString().substring(0, 7);

        const myDelivered = myDeliveries.filter(o => o.status === 'delivered');

        const statsToday = myDelivered.filter(o => o.created_at && new Date(o.created_at._seconds * 1000).toISOString().split('T')[0] === today);
        const statsMonth = myDelivered.filter(o => o.created_at && new Date(o.created_at._seconds * 1000).toISOString().substring(0, 7) === thisMonth);

        const caToday = statsToday.reduce((s, o) => s + (o.total_price || 0), 0);
        const caMonth = statsMonth.reduce((s, o) => s + (o.total_price || 0), 0);
        const caTotal = myDelivered.reduce((s, o) => s + (o.total_price || 0), 0);

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
        const orders = await getAllOrders(10);
        const myOrders = orders.filter(o => o.user_id === `telegram_${ctx.from.id}`);

        if (myOrders.length === 0) {
            return ctx.reply('📭 Vous n\'avez pas encore passé de commande.');
        }

        let text = `${settings.ui_icon_orders} <b>Mes dernières commandes :</b>\n\n`;
        myOrders.forEach(o => {
            const statusIcon = o.status === 'delivered' ? settings.ui_icon_success : (o.status === 'pending' ? settings.ui_icon_pending : settings.ui_icon_error);
            const statusLabel = o.status === 'delivered' ? settings.status_delivered_label : (o.status === 'pending' ? settings.status_pending_label : (o.status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label));

            text += `🔹 #${o.id.substring(0, 5)} - ${o.product_name} (${o.total_price}€)\n`;
            text += `├ Statut : ${statusIcon} <b>${statusLabel}</b>\n`;
            text += `└ Date : ${o.created_at ? new Date(o.created_at._seconds * 1000).toLocaleDateString() : '-'}\n\n`;
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
        await ctx.replyWithHTML(
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
            // Nettoyage du clavier immédiatement après la saisie via UX Autocomplétion
            await ctx.reply('⏳ Traitement de votre adresse...', Markup.removeKeyboard());
        } else if (ctx.message && ctx.message.text) {
            inputText = ctx.message.text.trim();
        } else {
            return;
        }

        if (inputText === '❌ Annuler la commande' || inputText.toLowerCase() === 'annuler') {
            pendingCityInput.delete(userId);
            pendingCityChange.delete(userId);
            return ctx.reply('❌ Commande annulée.', Markup.removeKeyboard());
        }

        // Si le livreur change de secteur
        if (pendingCityChange.has(userId)) {
            pendingCityChange.delete(userId);
            const city = inputText.replace(/<[^>]*>/g, '').trim();
            if (city.length < 2) {
                pendingCityChange.set(userId, true);
                return ctx.reply('❌ Nom de ville trop court. Réessayez :');
            }
            await updateLivreurPosition(userId, city);
            return ctx.replyWithHTML(
                `✅ Secteur mis à jour : <b>${city.toUpperCase()}</b>\n\nVous recevrez les commandes de cette zone.`,
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Espace Livreur', 'livreur_menu')]])
            );
        }

        // Si l'utilisateur est en attente de saisie d'adresse de livraison
        if (pendingCityInput.has(userId)) {
            const { productId, qty } = pendingCityInput.get(userId);
            const address = inputText.replace(/<[^>]*>/g, '').trim();

            if (address.length < 5) {
                return ctx.reply('❌ Adresse trop courte. Veuillez entrer votre adresse complète (ex: 11 rue de la Paix, 75001 Paris) :');
            }

            try {
                const settings = await getAppSettings();
                const products = await getProducts();
                const product = products.find(p => p.id === productId);

                if (!product) {
                    pendingCityInput.delete(userId);
                    return ctx.reply('❌ Produit non trouvé. Veuillez réessayer depuis le catalogue.', Markup.inlineKeyboard([[Markup.button.callback('🍔 Catalogue', 'view_catalog')]]));
                }

                const user = await getUser(userId);
                let totalPrice = product.price * qty;
                let discount = 0;

                if (user && user.wallet_balance > 0) {
                    discount = Math.min(totalPrice, user.wallet_balance);
                    totalPrice -= discount;
                    const dbModule = require('../services/database');
                    const userRef = dbModule.db.collection('bot_users').doc(userId);
                    await userRef.update({ wallet_balance: dbModule.incr(-discount) });
                }

                const orderId = await createOrder({
                    user_id: userId,
                    username: ctx.from.username || '',
                    first_name: ctx.from.first_name || 'Client',
                    product_name: product.name,
                    quantity: qty,
                    total_price: totalPrice,
                    discount_applied: discount,
                    city: address,
                    platform: 'telegram'
                });

                // Succès : on supprime l'attente
                pendingCityInput.delete(userId);
                console.log('[ORDER] ✅ Order created:', orderId);

                const discountText = discount > 0 ? `\n🎁 Réduction portefeuille : <b>-${discount.toFixed(2)}€</b>` : '';
                await ctx.replyWithHTML(
                    `${settings.msg_order_success || '✅ <b>Commande enregistrée !</b>'}\n\n` +
                    `📦 Produit : ${product.name} (x${qty})\n` +
                    `📍 Adresse : ${address}${discountText}\n` +
                    `💰 Total à payer : <b>${totalPrice.toFixed(2)}€</b>\n\n` +
                    `💵 <b>Paiement en liquide à la livraison.</b>\n` +
                    `${settings.msg_search_livreur || '⏳ Recherche d\'un livreur en cours...'}`,
                    Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]])
                );

                const notificationText = `🔔 <b>Nouvelle Commande !</b>\n\n` +
                    `📦 <b>${product.name} x${qty}</b>\n` +
                    `📍 Secteur : <b>${address.toUpperCase()}</b>\n` +
                    `💰 Total : <b>${totalPrice.toFixed(2)}€</b>\n\n` +
                    `ID: <code>${orderId.substring(0, 8)}...</code>`;

                const notificationKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🚴 Prendre la commande', `take_${orderId}`)]
                ]);

                if (settings.admin_telegram_id) {
                    bot.telegram.sendMessage(settings.admin_telegram_id,
                        notificationText + `\n👤 Client : ${ctx.from.first_name} (@${ctx.from.username || '?'})`,
                        { parse_mode: 'HTML' }
                    ).catch(e => console.error("Admin notify error:", e.message));
                }

                const availableLivreurs = await getAvailableLivreurs();
                availableLivreurs.forEach(livreur => {
                    const telegramId = livreur.platform_id;
                    if (telegramId && telegramId !== settings.admin_telegram_id) {
                        const sectors = livreur.sectors || (livreur.current_city ? [livreur.current_city.toLowerCase()] : []);
                        const isMatch = sectors.length === 0 || sectors.some(s => address.toLowerCase().includes(s));
                        if (isMatch) {
                            bot.telegram.sendMessage(telegramId, notificationText, {
                                parse_mode: 'HTML',
                                ...notificationKeyboard
                            }).catch(e => console.error(`Livreur ${telegramId} notify error:`, e.message));
                        }
                    }
                });
            } catch (err) {
                console.error('[ORDER] ❌ Error creating order:', err);
                await ctx.replyWithHTML(
                    '❌ <b>Erreur lors de la validation.</b>\n\nVeuillez vérifier votre adresse et recommencer :',
                    Markup.keyboard([["❌ Annuler la commande"]]).resize().oneTime()
                );
            }
            return;
        }
    });
}

module.exports = { setupOrderSystem };
