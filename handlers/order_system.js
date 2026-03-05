const { Markup } = require('telegraf');
const {
    getProducts, createOrder, getUser, setLivreurStatus,
    updateLivreurPosition, getAvailableOrdersByCity, updateOrderStatus,
    getOrder, getAppSettings, getAllOrders, setLivreurAvailability,
    incrementOrderCount, getAvailableLivreurs, getLastMenuId, _userCache
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

        let text = `${settings.ui_icon_catalog} <b>Catalogue ${settings.bot_name}</b>\n\nChoisissez un produit :`;
        const buttons = products.map(p => [Markup.button.callback(`${p.name} - ${p.price}€`, `product_${p.id}`)]);
        buttons.push([Markup.button.callback('◀️ Retour', 'main_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^product_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const products = await getProducts();
        const product = products.find(p => p.id === productId);
        const settings = ctx.state.settings;

        if (!product) return ctx.reply('❌ Produit non trouvé.');

        let text = `📦 <b>${product.name}</b>\n\n` +
            `💰 Prix : <b>${product.price}€</b>\n` +
            `📝 Description : ${product.description || 'Aucune'}\n\n` +
            `Combien en voulez-vous ?`;

        const buttons = [1, 2, 3, 4, 5].map(qty =>
            Markup.button.callback(`${qty}`, `qty_${productId}_${qty}`)
        );

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard([buttons, [Markup.button.callback('◀️ Retour', 'view_catalog')]]),
            media: product.image_url ? { type: 'photo', media: product.image_url } : null
        });
    });

    // Stockage temporaire des commandes en cours (in-memory simple)
    const pendingOrders = new Map();

    bot.action(/^qty_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const qty = parseInt(ctx.match[2]);
        const products = await getProducts();
        const product = products.find(p => p.id === productId);
        const settings = ctx.state.settings;

        if (!product) return ctx.reply('❌ Produit non trouvé.');

        const totalPrice = (product.price * qty).toFixed(2);
        pendingOrders.set(ctx.from.id, { productId, qty, totalPrice });

        await safeEdit(ctx,
            `✅ <b>${qty}x ${product.name}</b> ajouté au panier.\n` +
            `💰 Total : <b>${totalPrice}€</b>\n\n` +
            `📍 Veuillez nous envoyer votre <b>adresse de livraison</b> précise (ou utilisez l'autocomplétion) :`,
            Markup.inlineKeyboard([
                ...(settings.dashboard_url ? [[Markup.button.webApp("📍 Choisir sur la carte", `${settings.dashboard_url.replace('/dashboard', '/address_picker')}`)]] : []),
                [Markup.button.callback('◀️ Changer quantité', `product_${productId}`)],
                [Markup.button.callback('❌ Annuler', 'view_catalog')]
            ])
        );
    });

    // Capture de l'adresse (message texte)
    bot.on('message', async (ctx, next) => {
        if (!ctx.message.text || ctx.message.text.startsWith('/')) return next();

        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return next();

        const address = ctx.message.text;
        pending.address = address;

        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);
        const settings = ctx.state.settings;
        const user = await getUser(`telegram_${userId}`);

        // Calcul du prix final et de la règle de fidélité
        const totalPriceRaw = parseFloat(pending.totalPrice);

        // Supprimer le message d'adresse utilisateur pour flux propre
        await ctx.deleteMessage().catch(() => { });

        // SI CRÉDIT DISPONIBLE → ON DEMANDE (En respectant la règle de fidélité)
        if (user && user.wallet_balance > 0) {
            const maxPct = settings.fidelity_wallet_max_pct || 50;
            const minSpend = settings.fidelity_min_spend || 0;

            const maxAllowedCredit = (totalPriceRaw * maxPct) / 100;
            const possibleDiscount = Math.min(maxAllowedCredit, user.wallet_balance);

            if (totalPriceRaw >= minSpend && possibleDiscount > 0) {
                pendingOrderConfirmation.set(userId, { ...pending, possibleDiscount });
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

        // Sinon paiement normal cash
        await showOrderSummary(ctx, product, pending.qty, address, totalPriceRaw, 0);
    });

    const pendingOrderConfirmation = new Map();

    bot.action('confirm_order_use_credit_yes', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);
        const finalPrice = parseFloat(pending.totalPrice) - pending.possibleDiscount;

        await showOrderSummary(ctx, product, pending.qty, pending.address, finalPrice, pending.possibleDiscount);
    });

    bot.action('confirm_order_use_credit_no', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);

        await showOrderSummary(ctx, product, pending.qty, pending.address, parseFloat(pending.totalPrice), 0);
    });

    async function showOrderSummary(ctx, product, qty, address, finalPrice, discount) {
        const text = `🛒 <b>Récapitulatif de Commande</b>\n\n` +
            `📦 Produit : ${product.name} (x${qty})\n` +
            `📍 Adresse : ${address}\n` +
            `💰 Prix : ${qty * product.price}€\n` +
            (discount > 0 ? `🎁 Réduction solde : -${discount.toFixed(2)}€\n` : '') +
            `💵 <b>TOTAL À RÉGLER : ${finalPrice.toFixed(2)}€</b>\n\n` +
            `Confirmez-vous la commande ?`;

        await safeEdit(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('✅ CONFIRMER LA COMMANDE', `create_order_${discount > 0 ? 'discount' : 'normal'}`)],
            [Markup.button.callback('❌ Annuler', 'view_catalog')]
        ]));
    }

    bot.action(/^create_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const useDiscount = ctx.match[1] === 'discount';
        const pending = useDiscount ? pendingOrderConfirmation.get(userId) : pendingOrders.get(userId);

        if (!pending) return ctx.reply('❌ Session expirée.');

        const products = await getProducts();
        const product = products.find(p => p.id === pending.productId);
        const discount = useDiscount ? pending.possibleDiscount : 0;
        const finalPrice = parseFloat(pending.totalPrice) - discount;

        const orderData = {
            user_id: `telegram_${userId}`,
            username: ctx.from.username || 'Inconnu',
            first_name: ctx.from.first_name || 'Inconnu',
            product_id: product.id,
            product_name: product.name,
            quantity: pending.qty,
            total_price: finalPrice,
            address: pending.address,
            status: 'pending',
            discount_applied: discount
        };

        const { order, error } = await createOrder(orderData);
        if (error) return ctx.reply('❌ Erreur lors de la création de la commande.');

        // Si crédit utilisé -> Déduire du wallet
        if (discount > 0) {
            const user = await getUser(`telegram_${userId}`);
            const { updateUserWallet } = require('../services/database');
            await updateUserWallet(`telegram_${userId}`, user.wallet_balance - discount);
        }

        pendingOrders.delete(userId);
        pendingOrderConfirmation.delete(userId);

        const settings = ctx.state.settings;
        await safeEdit(ctx,
            `✅ <b>Commande enregistrée !</b>\n\n` +
            `📦 Produit : ${product.name} (x${pending.qty})\n` +
            `📍 Adresse : ${pending.address}\n` +
            `💰 Total : <b>${finalPrice.toFixed(2)}€</b>\n\n` +
            `⏳ Recherche d'un livreur en cours...`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]])
        );

        // Alerte aux admins
        if (settings.admin_telegram_id) {
            const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
            for (const adminId of adminIds) {
                bot.telegram.sendMessage(adminId,
                    `🚨 <b>NOUVELLE COMMANDE !</b>\n\n` +
                    `👤 Client : ${ctx.from.first_name} (@${ctx.from.username})\n` +
                    `📦 Produit : ${product.name} (x${pending.qty})\n` +
                    `📍 Adresse : ${pending.address}\n` +
                    `💰 Total : ${finalPrice.toFixed(2)}€\n` +
                    `🔑 ID : <code>${order.id}</code>\n\n` +
                    `Utilisez le dashboard pour l'assigner à un livreur.`,
                    { parse_mode: 'HTML' }
                ).catch(() => { });
            }
        }
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
        const docId = `telegram_${ctx.from.id}`;

        // 1. Toast immédiat
        await ctx.answerCbQuery(`Statut : ${isAvailable ? 'DISPONIBLE ✅' : 'INDISPONIBLE 😴'}`);

        // 2. Update DB
        await setLivreurAvailability(docId, isAvailable);

        // 3. Invalidation Cache
        if (_userCache) _userCache.delete(docId);

        // 4. Force l'affichage local (Sans attendre la DB / Cache)
        const settings = await getAppSettings();
        let user = await getUser(docId);

        // On écrase manuellement les valeurs locales pour l'interface
        if (user) {
            user.is_available = isAvailable;
            if (!user.data) user.data = {};
            user.data.is_available = isAvailable;
        }

        const { getLivreurMenuKeyboard } = require('./start');
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
            `👤 ${user ? user.first_name : ctx.from.first_name}\n` +
            `📍 Secteur : <b>${user?.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
            `🔘 Statut : <b>${isAvailable ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const opts = { parse_mode: 'HTML', ...getLivreurMenuKeyboard(settings, user) };
        await safeEdit(ctx, text, opts);

        // 5. Cleanup bouton "Démarrer"
        ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });
    });

    bot.command('ma_position', async (ctx) => {
        const city = ctx.message.text.split(' ')[1];
        if (!city) return ctx.reply('❌ Usage: /ma_position [ville]');

        await updateLivreurPosition(`telegram_${ctx.from.id}`, city.toLowerCase());
        await ctx.reply(`📍 Secteur mis à jour : ${city.toUpperCase()}`);
    });

    bot.action('change_city', async (ctx) => {
        await ctx.answerCbQuery();
        const sectors = [
            ['📍 Paris / IDF', 'sector_paris_idf'],
            ['📍 Marseille / PACA', 'sector_marseille_paca'],
            ['📍 Lyon / Rhône-Alpes', 'sector_lyon_ra'],
            ['📍 Lille / HDF', 'sector_lille_hdf'],
            ['📍 Bordeaux / Aquitaine', 'sector_bordeaux_na'],
            ['📍 Toulouse / Occitanie', 'sector_toulouse_occ'],
            ['⌨️ Autre (Saisie libre)', 'sector_manual']
        ];

        const buttons = sectors.map(s => [Markup.button.callback(s[0], s[1])]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx,
            `📍 <b>SÉLECTION DU SECTEUR</b>\n\nChoisissez votre zone de livraison principale :`,
            Markup.inlineKeyboard(buttons)
        );
    });

    bot.action(/^sector_(.+)$/, async (ctx) => {
        const choice = ctx.match[1];
        if (choice === 'manual') {
            await ctx.answerCbQuery();
            await safeEdit(ctx,
                '⌨️ <b>Saisie manuelle</b>\n\nVeuillez envoyer le nom de votre ville ou secteur (ex: Bordeaux, Nice...) :',
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'change_city')]])
            );
            ctx.state.awaiting_city = true;
            return;
        }

        const sectorMap = {
            'paris_idf': 'Paris + IDF',
            'marseille_paca': 'Marseille + PACA',
            'lyon_ra': 'Lyon + Rhône-Alpes',
            'lille_hdf': 'Lille + Hauts-de-France',
            'bordeaux_na': 'Bordeaux + Aquitaine',
            'toulouse_occ': 'Toulouse + Occitanie'
        };

        const cityName = sectorMap[choice] || choice;
        await ctx.answerCbQuery(`Secteur : ${cityName} ✅`);

        await updateLivreurPosition(`telegram_${ctx.from.id}`, cityName.toLowerCase());

        // Rafraichir le menu livreur
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        const { getLivreurMenuKeyboard } = require('./start');

        const isAvail = user.is_available || (user.data && user.data.is_available);
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
            `👤 ${user.first_name}\n` +
            `📍 Secteur : <b>${cityName.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const opts = { parse_mode: 'HTML', ...getLivreurMenuKeyboard(settings, user) };
        return await safeEdit(ctx, text, opts);
    });

    bot.action('show_city_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.current_city) {
            return safeEdit(ctx, '❌ Vous n\'avez pas défini de secteur. Utilisez "Changer de secteur".');
        }

        const orders = await getAvailableOrdersByCity(user.current_city);
        if (orders.length === 0) {
            return safeEdit(ctx, `📭 Aucune commande disponible à ${user.current_city.toUpperCase()}.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
        }

        let text = `📦 <b>Commandes à ${user.current_city.toUpperCase()}</b>\n\n`;
        const buttons = orders.map(o => [Markup.button.callback(`${o.product_name} - ${o.total_price}€`, `take_order_${o.id}`)]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^take_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);

        if (!order || order.status !== 'pending') return ctx.reply('❌ Cette commande n\'est plus disponible.');

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
        await incrementOrderCount(`telegram_${ctx.from.id}`);

        await safeEdit(ctx, `✅ Commande <b>#${orderId.substring(0, 5)}</b> marquée comme LIVRÉE !\nFélicitations pour votre livraison.`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]])
        });

        // Notifier client
        bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
            `✅ <b>Votre commande #${orderId.substring(0, 5)} a été livrée !</b>\n\n` +
            `Merci de votre confiance et à bientôt chez ${settings.bot_name} !`,
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
                    [Markup.button.callback(`${settings.ui_icon_catalog} Voir le catalogue`, 'view_catalog')],
                    [Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]
                ])
            }
        );
    });

    bot.action('my_deliveries', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const { getLivreurHistory } = require('../services/database');

        try {
            const deliveries = await getLivreurHistory(userId);

            if (deliveries.length === 0) {
                return safeEdit(ctx, `📭 Votre historique de livraison est vide.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
            }

            let text = `📊 <b>Mon historique de livraisons</b>\n\n`;
            let totalEarned = 0;

            deliveries.forEach((d, i) => {
                // Parsing date Supabase simple
                const dateStr = d.created_at ? new Date(d.created_at).toLocaleDateString('fr-FR') : 'Date inconnue';
                text += `${i + 1}. #${d.id.substring(0, 5)} - ${d.product_name} (${d.total_price}€)\n` +
                    `📅 ${dateStr} - 📍 ${d.address.substring(0, 20)}...\n\n`;
                totalEarned += parseFloat(d.total_price);
            });

            text += `💰 <b>Total cumulé livré : ${totalEarned.toFixed(2)}€</b>`;

            await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
        } catch (e) {
            console.error('Error fetching delivery history:', e);
            await safeEdit(ctx, '❌ Erreur lors de la récupération de l\'historique.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
        }
    });

    bot.on('text', async (ctx, next) => {
        if (ctx.state.awaiting_city) {
            const city = ctx.message.text.trim().toLowerCase();
            const docId = `telegram_${ctx.from.id}`;
            const { updateLivreurPosition, getLivreurMenuKeyboard } = require('../services/database');

            await updateLivreurPosition(docId, city);

            // Nettoyage input
            await ctx.deleteMessage().catch(() => { });

            const settings = ctx.state.settings;
            const user = await getUser(docId);
            const { getLivreurMenuKeyboard: getKB } = require('./start');

            const text = `✅ <b>Secteur validé : ${city.toUpperCase()}</b>\n\n` +
                `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
                `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
                `🔘 Statut : <b>${user.is_available ? 'DISPONIBLE' : 'INDISPONIBLE'}</b>`;

            await safeEdit(ctx, text, getKB(settings, user));
            delete ctx.state.awaiting_city;
            return;
        }
        await next();
    });
}

module.exports = { setupOrderSystem };
