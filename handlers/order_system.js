const { Markup } = require('telegraf');
const {
    getProducts, createOrder, getUser, setLivreurStatus,
    updateLivreurPosition, getAvailableOrders, updateOrderStatus,
    getOrder, getAppSettings, setLivreurAvailability,
    incrementOrderCount, getAllLivreurs, _userCache
} = require('../services/database');
const { safeEdit, debugLog } = require('../services/utils');

// ======= ÉTAT EN MÉMOIRE (PERSISTANT PENDANT RUNTIME) =======
const userCarts = new Map();
const pendingOrders = new Map();
const awaitingAddressDetails = new Map();
const pendingOrderConfirmation = new Map();

function setupOrderSystem(bot) {
    // ========== CATALOGUE & COMMANDE ==========

    bot.action('view_catalog', async (ctx) => {
        await ctx.answerCbQuery();
        const products = await getProducts();
        if (!products || products.length === 0) {
            return safeEdit(ctx, '📭 Le catalogue est actuellement vide.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'main_menu')]]));
        }

        let text = `${ctx.state.settings.ui_icon_catalog} <b>Catalogue ${ctx.state.settings.bot_name}</b>\n\nChoisissez un produit :`;
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

        if (!product) return safeEdit(ctx, '❌ Produit non trouvé.', [Markup.button.callback('◀️ Retour', 'view_catalog')]);

        let text = `📦 <b>${product.name}</b>\n\n` +
            `💰 Prix : <b>${product.price}€</b>\n` +
            `📝 Description : ${product.description || 'Aucune'}\n\n` +
            `Combien en voulez-vous ?`;

        const buttons = [1, 2, 3, 4, 5].map(qty =>
            Markup.button.callback(`${qty}`, `qty_${productId}_${qty}`)
        );

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard([buttons, [Markup.button.callback('◀️ Retour', 'view_catalog')]]),
            photo: product.image_url || null
        });
    });

    bot.action(/^qty_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const qty = parseInt(ctx.match[2]);
        const products = await getProducts();
        const product = products.find(p => p.id === productId);
        const settings = ctx.state.settings;

        if (!product) return safeEdit(ctx, '❌ Produit non trouvé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'view_catalog')]]));

        const totalPrice = (product.price * qty).toFixed(2);
        pendingOrders.set(ctx.from.id, { productId, qty, totalPrice, productName: product.name });

        if (product.unit && product.unit.length > 0 && !(['unité', 'unite', 'piece', 'pce'].includes(product.unit.toLowerCase()))) {
            return askUnit(ctx, product, qty);
        }

        await showAddToCartChoice(ctx, product, qty, totalPrice);
    });

    async function showAddToCartChoice(ctx, product, qty, totalPrice, unitAmount = null) {
        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée."); // Sécurité
        if (unitAmount) pending.chosen_unit_amount = unitAmount;

        const text = `🛒 <b>Sélection : ${qty}x ${product.name}${unitAmount ? ` (${unitAmount})` : ''}</b>\n` +
            `💰 Prix : <b>${totalPrice}€</b>\n\n` +
            `Que voulez-vous faire ?`;

        const buttons = [
            [Markup.button.callback('🛒 Ajouter au panier', 'add_to_cart')],
            [Markup.button.callback('💳 Régler maintenant', 'checkout_now')],
            [Markup.button.callback('◀️ Retour', `product_${product.id}`)]
        ];

        // Snappiness: Pass photo to avoid delete/re-send cycle in safeEdit
        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard(buttons),
            photo: product.image_url
        });
    }

    bot.action('add_to_cart', async (ctx) => {
        await ctx.answerCbQuery('Ajouté au panier ! 🛒');
        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée.");

        let cart = userCarts.get(userId) || [];
        cart.push(pending);
        userCarts.set(userId, cart);
        pendingOrders.delete(userId);

        const products = await getProducts();
        const text = `✅ Produit ajouté !\n\nVotre panier contient <b>${cart.length}</b> article(s).`;
        const buttons = [
            [Markup.button.callback('🛍️ Continuer mes achats', 'view_catalog')],
            [Markup.button.callback('💳 Voir mon panier / Commander', 'view_cart')],
            [Markup.button.callback('❌ Vider le panier', 'clear_cart')]
        ];
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('checkout_now', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return;

        let cart = userCarts.get(userId) || [];
        cart.push(pending);
        userCarts.set(userId, cart);
        pendingOrders.delete(userId);

        await startCheckout(ctx);
    });

    bot.action('view_cart', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const cart = userCarts.get(userId) || [];
        if (cart.length === 0) return ctx.answerCbQuery('Votre panier est vide 📭');

        let total = 0;
        let summary = `🛒 <b>Votre Panier</b>\n\n`;
        const buttons = [];

        cart.forEach((item, idx) => {
            const price = parseFloat(item.totalPrice);
            total += price;
            summary += `${idx + 1}. ${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''} - <b>${price.toFixed(2)}€</b>\n`;
            // Bouton de suppression individuelle
            buttons.push([Markup.button.callback(`❌ Retirer ${item.productName.substring(0, 15)}...`, `remove_item_${idx}`)]);
        });
        summary += `\n💰 <b>TOTAL : ${total.toFixed(2)}€</b>`;

        buttons.push([Markup.button.callback('💳 Commander', 'start_checkout')]);
        buttons.push([Markup.button.callback('🛍️ Continuer mes achats', 'view_catalog')]);
        buttons.push([Markup.button.callback('❌ Vider le panier', 'clear_cart')]);

        await safeEdit(ctx, summary, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^remove_item_(.+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        let cart = userCarts.get(userId) || [];
        if (cart[idx]) {
            await ctx.answerCbQuery(`Retiré : ${cart[idx].productName}`);
            cart.splice(idx, 1);
            userCarts.set(userId, cart);
        }
        // Retour au panier
        if (cart.length === 0) {
            return safeEdit(ctx, 'Votre panier est maintenant vide. 📭', Markup.inlineKeyboard([[Markup.button.callback('🛍️ Retour au Catalogue', 'view_catalog')]]));
        }
        // On re-déclenche l'action view_cart (on simule)
        return await ctx.handleUpdate({
            ...ctx.update,
            callback_query: { ...ctx.callbackQuery, data: 'view_cart' }
        });
    });

    bot.action('clear_cart', async (ctx) => {
        await ctx.answerCbQuery('Panier vidé 🗑️');
        userCarts.delete(ctx.from.id);
        await ctx.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'view_catalog' } });
    });

    bot.action('start_checkout', async (ctx) => {
        await ctx.answerCbQuery();
        await startCheckout(ctx);
    });

    async function startCheckout(ctx) {
        const userId = ctx.from.id;
        const cart = userCarts.get(userId) || [];
        if (cart.length === 0) return ctx.reply("Votre panier est vide.");

        const settings = ctx.state.settings;
        const minOrder = settings.fidelity_min_spend || 50;
        let total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);

        if (total < minOrder) {
            return safeEdit(ctx,
                `⚠️ <b>Minimum de commande non atteint</b>\n\n` +
                `Nous ne livrons pas en dessous de <b>${minOrder}€</b>.\n` +
                `Votre total actuel : <b>${total.toFixed(2)}€</b>\n\n` +
                `Veuillez ajouter d'autres produits à votre panier.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🛍️ Ajouter des produits', 'view_catalog')],
                    [Markup.button.callback('🛒 Retour au Panier', 'view_cart')]
                ])
            );
        }

        await promptAddressEntry(ctx, total);
    }

    async function promptAddressEntry(ctx, totalPrice) {
        const userId = ctx.from.id;
        const cart = userCarts.get(userId) || [];
        const itemsText = cart.map(item => `• ${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}`).join('\n');

        // On persiste l'état d'attente d'adresse dans le Map global
        awaitingAddressDetails.set(userId, { step: 1, total: totalPrice });

        await safeEdit(ctx,
            `🛒 <b>Votre Panier :</b>\n${itemsText}\n` +
            `💰 Montant : <b>${totalPrice.toFixed(2)}€</b>\n\n` +
            `🏁 <b>Étape 1 : Adresse de livraison</b>\n\n` +
            `Veuillez envoyer votre <b>adresse précise</b> avec le <b>code postal</b> (Numéro, Rue, CP, Ville).\n\n` +
            `⚠️ <i>Le code postal est obligatoire.</i>\n\n` +
            `💬 <i>Exemple : 45 rue de la Paix, 75002 Paris</i>`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Panier', 'view_cart')]])
        );
    }

    async function askUnit(ctx, product, qty) {
        const unit = product.unit;
        const baseVal = parseFloat(product.unit_value) || 1;
        const text = `⚖️ <b>Sélecton du format pour ${product.name}</b>\n\n` +
            `L'unité de base est de <b>${baseVal}${unit}</b> au prix de <b>${product.price}€</b>.\n\n` +
            `Choisissez le poids/volume souhaité :`;

        const options = [1, 2, 5, 10, 20].map(m => {
            const amount = baseVal * m;
            return Markup.button.callback(`${amount}${unit}`, `unitselect_${product.id}_${qty}_${amount}`);
        });

        const rows = [];
        for (let i = 0; i < options.length; i += 2) rows.push(options.slice(i, i + 2));
        rows.push([Markup.button.callback('◀️ Retour Quantité', `product_${product.id}`)]);
        rows.push([Markup.button.callback('❌ Annuler', 'view_catalog')]);

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard(rows),
            photo: product.image_url
        });
    }

    bot.action(/^unitselect_(.+)_(.+)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const [pId, qtyStr, amountStr] = ctx.match.slice(1);
        const qty = parseInt(qtyStr);
        const amount = parseFloat(amountStr);
        const products = await getProducts();
        const product = products.find(p => p.id === pId);

        if (!product) return ctx.reply("Produit non trouvé.");

        const baseVal = parseFloat(product.unit_value) || 1;
        const finalPrice = ((product.price / baseVal) * amount * qty).toFixed(2);

        const pending = pendingOrders.get(ctx.from.id);
        if (pending) {
            pending.totalPrice = finalPrice;
            pending.chosen_unit_amount = `${amount}${product.unit}`;
        }

        await showAddToCartChoice(ctx, product, qty, finalPrice, `${amount}${product.unit}`);
    });

    async function promptAddress(ctx, product, qty, totalPrice) {
        const settings = ctx.state.settings;
        await safeEdit(ctx,
            `✅ <b>${qty}x ${product.name}</b> ajouté au panier.\n` +
            `💰 Total : <b>${totalPrice}€</b>\n\n` +
            `📍 Veuillez nous envoyer votre <b>adresse de livraison</b> précise :`,
            {
                ...Markup.inlineKeyboard([
                    ...(settings.dashboard_url ? [[Markup.button.webApp("📍 Choisir sur la carte", `${settings.dashboard_url.replace('/dashboard', '/address_picker')}`)]] : []),
                    [Markup.button.callback('◀️ Retour Quantité', product.unit ? `qty_${product.id}_${qty}` : `product_${product.id}`)],
                    [Markup.button.callback('❌ Annuler', 'view_catalog')]
                ]),
                photo: product.image_url || null
            }
        );
    }

    // Capture de l'adresse (message texte)
    bot.on('message', async (ctx, next) => {
        if (!ctx.message.text || ctx.message.text.startsWith('/')) return next();
        const userId = ctx.from.id;

        const addrState = awaitingAddressDetails.get(userId);

        // Step 1: Address Validation -> Suite vers SCHEDULING
        if (addrState && addrState.step === 1) {
            const addr = ctx.message.text.trim();
            const hasNumber = /\d/.test(addr);
            const hasPostalCode = /\b\d{5}\b/.test(addr);

            if (addr.length < 8 || !hasNumber || !hasPostalCode) {
                let errorMsg = "❌ <b>Adresse incomplète.</b>\n\n";
                if (!hasPostalCode) errorMsg += "📍 Veuillez inclure un <b>code postal à 5 chiffres</b>.\n";
                errorMsg += "\nVeuillez renvoyer l'adresse complète (Numéro + Rue + CP + Ville).";

                await ctx.reply(errorMsg, { parse_mode: 'HTML' });
                return;
            }

            // On sauve l'adresse et on passe au Scheduling
            addrState.address = addr;

            // On prépare le pending order pour le scheduling
            const cart = userCarts.get(userId) || [];
            const total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);
            pendingOrders.set(userId, { address: addr, totalPrice: total, isCart: true });

            await ctx.deleteMessage().catch(() => { });
            return await askScheduling(ctx);
        }

        // Step 2: Details Capture -> FINALISATION
        if (addrState && addrState.step === 2 && !addrState.finalized) {
            const details = ctx.message.text.trim();
            addrState.address += ` (Infos : ${details})`;
            addrState.finalized = true;
            await ctx.deleteMessage().catch(() => { });
            return await finalizeCheckoutFlow(ctx, addrState.address);
        }

        return next();
    });

    bot.action('address_details_skip', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const data = awaitingAddressDetails.get(userId);
        if (!data) return;
        data.finalized = true;
        await finalizeCheckoutFlow(ctx, data.address);
    });

    async function finalizeCheckoutFlow(ctx, fullAddress) {
        const userId = ctx.from.id;
        const cart = userCarts.get(userId) || [];
        const total = cart.reduce((acc, item) => acc + parseFloat(item.totalPrice), 0);

        // Récupérer les donées de scheduling
        const pending = pendingOrders.get(userId);
        const scheduled_at = pending ? pending.scheduled_at : null;

        const checkoutData = {
            isCart: true,
            address: fullAddress,
            totalPrice: total,
            scheduled_at: scheduled_at,
            userId: userId
        };
        pendingOrders.set(userId, checkoutData);

        const settings = ctx.state.settings;
        const user = await getUser(`telegram_${userId}`);

        // SI CRÉDIT DISPONIBLE → ON DEMANDE (Step Finale)
        if (user && user.wallet_balance > 0) {
            const maxPct = settings.fidelity_wallet_max_pct || 50;
            const minSpend = settings.fidelity_min_spend || 50;

            // On calcule combien on peut déduire sans descendre sous le minSpend
            const maxAllowedByPct = (total * maxPct) / 100;
            const maxToKeepMinSpend = Math.max(0, total - minSpend);

            const possibleDiscount = Math.min(maxAllowedByPct, user.wallet_balance, maxToKeepMinSpend);

            if (possibleDiscount > 0) {
                pendingOrderConfirmation.set(userId, { ...checkoutData, possibleDiscount });
                return safeEdit(ctx,
                    `💰 <b>Utiliser votre solde ?</b>\n\n` +
                    `Votre solde actuel : <b>${(user.wallet_balance).toFixed(2)}€</b>\n` +
                    `Réduction possible : <b>${possibleDiscount.toFixed(2)}€</b>.\n\n` +
                    `Voulez-vous l'appliquer ?`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback(`✅ Oui, déduire ${possibleDiscount.toFixed(2)}€`, 'confirm_order_use_credit_yes')],
                        [Markup.button.callback('❌ Non, payer plein tarif', 'confirm_order_use_credit_no')],
                        [Markup.button.callback('◀️ Retour Adresse', 'start_checkout')]
                    ])
                );
            }
        }

        await showCartSummary(ctx, fullAddress, total, 0, scheduled_at);
    }

    async function askScheduling(ctx) {
        const text = `🕒 <b>Quand souhaitez-vous être livré ?</b>\n\nChoisissez si vous voulez être livré dès que possible ou planifier un horaire précis.`;
        const buttons = [
            [Markup.button.callback('🚀 Immédiatement', 'scheduling_now')],
            [Markup.button.callback('🕒 Planifier une heure', 'scheduling_plan')],
            [Markup.button.callback('◀️ Retour Adresse', 'back_to_address')],
            [Markup.button.callback('❌ Annuler', 'view_catalog')]
        ];
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    }

    bot.action('scheduling_now', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée.");
        pending.scheduled_at = null;

        // Après le scheduling, on demande les détails facultatifs
        await promptAddressDetails(ctx);
    });

    async function promptAddressDetails(ctx) {
        const userId = ctx.from.id;
        const addrState = awaitingAddressDetails.get(userId);
        if (addrState) addrState.step = 2;

        const text = `🏢 <b>Détails de livraison (Optionnel)</b>\n\nIndiquez votre <b>digicode, étage, numéro d'appartement</b> ou toute info utile pour le livreur.\n\nSinon, cliquez sur le bouton ci-dessous :`;
        const buttons = [
            [Markup.button.callback('⏭ Passer cette étape', 'address_details_skip')],
            [Markup.button.callback('◀️ Modifier l\'adresse', 'start_checkout')]
        ];
        return await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    }

    bot.action('scheduling_plan', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `📅 <b>Choisissez le moment de livraison :</b>`;
        const buttons = [];

        // On propose des créneaux
        const now = new Date();
        // On propose des créneaux sur 7 jours
        const dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(now.getDate() + i);
            dates.push(d);
        }

        dates.forEach((d, idx) => {
            const dateStr = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
            const dateKey = d.toISOString().split('T')[0];
            let label = "";
            if (idx === 0) label = `Aujourd'hui (${dateStr})`;
            else if (idx === 1) label = `Demain (${dateStr})`;
            else label = `${dateStr}`;

            buttons.push([Markup.button.callback(label, `sched_date_${dateKey}`)]);
        });

        buttons.push([Markup.button.callback('◀️ Retour', 'back_to_scheduling')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^sched_date_(.+)$/, async (ctx) => {
        const date = ctx.match[1];
        await ctx.answerCbQuery();
        const text = `🕒 <b>À quelle heure ?</b>\n\nSélectionnez un créneau horaire :`;

        // Génération automatique des créneaux (de 00h à 23h, heures pleines uniquement)
        const slots = [];
        for (let h = 0; h < 24; h++) {
            slots.push(`${h.toString().padStart(2, '0')}h00`);
        }

        const buttons = [];
        for (let i = 0; i < slots.length; i += 4) {
            const row = slots.slice(i, i + 4).map(s => Markup.button.callback(s, `sched_final_${date}_${s}`));
            buttons.push(row);
        }
        buttons.push([Markup.button.callback('◀️ Retour', 'scheduling_plan')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^sched_final_(.+)_(.+)$/, async (ctx) => {
        const [date, hour] = [ctx.match[1], ctx.match[2]];
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrders.get(userId);
        if (!pending) return ctx.reply("Session expirée.");

        pending.scheduled_at = `${date} ${hour}`;

        // On demande les détails facultatifs avant de finir
        await promptAddressDetails(ctx);
    });

    bot.action('back_to_address', async (ctx) => {
        await ctx.answerCbQuery();
        await startCheckout(ctx);
    });

    bot.action('back_to_scheduling', async (ctx) => {
        await ctx.answerCbQuery();
        await askScheduling(ctx);
    });



    bot.action('confirm_order_use_credit_yes', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const finalPrice = parseFloat(pending.totalPrice) - pending.possibleDiscount;
        await showCartSummary(ctx, pending.address, finalPrice, pending.possibleDiscount, pending.scheduled_at);
    });

    bot.action('confirm_order_use_credit_no', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const pending = pendingOrderConfirmation.get(userId);
        if (!pending) return safeEdit(ctx, "Sesssion expirée ❌", Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        await showCartSummary(ctx, pending.address, parseFloat(pending.totalPrice), 0, pending.scheduled_at);
    });

    bot.action('my_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = `telegram_${ctx.from.id}`;
        const { getOrdersByUser } = require('../services/database');

        try {
            const orders = await getOrdersByUser(userId);
            if (orders.length === 0) {
                return safeEdit(ctx, '📭 Vous n\'avez pas encore de commandes.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            }

            let text = `📦 <b>Mes Commandes</b>\n\n`;
            orders.slice(0, 10).forEach((o, i) => {
                const date = o.created_at ? new Date(o.created_at).toLocaleDateString('fr-FR') : 'Inconnue';
                const statusLabel = o.status === 'delivered' ? '✅ Livrée' : (o.status === 'cancelled' ? '❌ Annulée' : '⏳ En cours');
                text += `${i + 1}. #${o.id.substring(0, 5)} - ${o.product_name}\n` +
                    `💰 ${o.total_price}€ - ${statusLabel} (${date})\n\n`;
            });

            await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        } catch (e) {
            console.error('Error fetching user orders:', e);
            await safeEdit(ctx, '❌ Erreur lors de la récupération de vos commandes.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }
    });

    async function showCartSummary(ctx, address, finalPrice, discount, scheduledAt = null) {
        const userId = ctx.from.id;
        const cart = userCarts.get(userId) || [];

        let cartText = ``;
        cart.forEach((item, idx) => {
            cartText += `📦 <b>${item.productName}</b> (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}\n`;
        });

        const text = `🛒 <b>Récapitulatif de Commande</b>\n\n` +
            cartText +
            `📍 Adresse : ${address}\n` +
            (scheduledAt ? `🕒 Planifié pour : <b>${scheduledAt}</b>\n` : `🚀 Livraison : Dès que possible\n`) +
            `💰 Total : <b>${(finalPrice + discount).toFixed(2)}€</b>\n` +
            (discount > 0 ? `🎁 Réduction solde : -${discount.toFixed(2)}€\n` : '') +
            `💵 <b>NET À RÉGLER : ${finalPrice.toFixed(2)}€</b>\n\n` +
            `Confirmez-vous la commande ?`;

        await safeEdit(ctx, text, {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ CONFIRMER LA COMMANDE', `create_order_${discount > 0 ? 'discount' : 'normal'}`)],
                [Markup.button.callback('◀️ Modifier livraison', 'back_to_scheduling')],
                [Markup.button.callback('❌ Annuler', 'view_catalog')]
            ])
        });
    }

    bot.action(/^create_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const useDiscount = ctx.match[1] === 'discount';
        const pending = useDiscount ? pendingOrderConfirmation.get(userId) : pendingOrders.get(userId);
        if (!pending) return safeEdit(ctx, '❌ Session expirée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const cart = userCarts.get(userId) || [];
        const productList = cart.map(item => `${item.productName} (x${item.qty})${item.chosen_unit_amount ? ` [${item.chosen_unit_amount}]` : ''}`).join(', ');
        const totalQty = cart.reduce((acc, item) => acc + item.qty, 0);

        const discount = useDiscount ? pending.possibleDiscount : 0;
        const finalPrice = parseFloat(pending.totalPrice) - discount;

        // Tentative d'extraction de la ville depuis l'adresse
        let city = null;
        const addr = (pending.address || '').toLowerCase();
        if (addr.includes('paris') || addr.includes('idf') || addr.includes('75') || addr.includes('92') || addr.includes('93') || addr.includes('94')) city = 'paris';
        else if (addr.includes('marseille') || addr.includes('1300')) city = 'marseille';
        else if (addr.includes('lyon')) city = 'lyon';
        else if (addr.includes('lille')) city = 'lille';
        else if (addr.includes('bordeaux')) city = 'bordeaux';
        else if (addr.includes('toulouse')) city = 'toulouse';

        const orderData = {
            user_id: `telegram_${userId}`,
            username: ctx.from.username || 'Inconnu',
            first_name: ctx.from.first_name || 'Inconnu',
            product_name: productList,
            quantity: totalQty,
            total_price: finalPrice,
            address: pending.address,
            city: city, // Ajout de la ville pour le filtrage livreur
            platform: 'telegram',
            status: 'pending',
            discount_applied: discount,
            scheduled_at: pending.scheduled_at || null
        };

        const { order, error: createError } = await createOrder(orderData);
        if (createError) {
            console.error("Error creating order:", createError);
            return safeEdit(ctx, '❌ Erreur lors de la création de la commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }

        const successText = ctx.state.settings.msg_order_success || `✅ <b>Commande #${order.id.substring(0, 5)} envoyée !</b>\n\nUn livreur va vous contacter dès qu'elle sera prise en charge.`;

        // Removed duplicate createOrder call
        userCarts.delete(userId); // Vider le panier après commande
        pendingOrders.delete(userId);
        pendingOrderConfirmation.delete(userId);
        awaitingAddressDetails.delete(userId);

        const settings = ctx.state.settings;
        await safeEdit(ctx,
            `✅ <b>Commande enregistrée !</b>\n\n` +
            `📦 Produit : ${productList}\n` +
            `📍 Adresse : ${pending.address}\n` +
            (pending.scheduled_at ? `🕒 Prévu pour : <b>${pending.scheduled_at}</b>\n` : `🚀 Livraison : Dès que possible\n`) +
            `💰 Total : <b>${finalPrice.toFixed(2)}€</b>\n\n` +
            `${settings.ui_icon_success || '✅'} Recherche d'un livreur en cours...`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]])
        );

        // Notify Admin / Livreurs
        const notificationText = `🆕 <b>NOUVELLE COMMANDE !</b>\n\n` +
            `📦 ${productList}\n` +
            `📍 ${pending.address}\n` +
            (pending.scheduled_at ? `🕒 <b>Prévu pour : ${pending.scheduled_at}</b>\n` : `🕒 Dès que possible\n`) +
            `💰 <b>${finalPrice.toFixed(2)}€</b>\n\n` +
            `<i>Ouvrez votre espace livreur pour la prendre.</i>`;
        // Alerte aux admins
        if (ctx.state.settings.admin_telegram_id) {
            const adminIds = String(ctx.state.settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
            for (const adminId of adminIds) {
                bot.telegram.sendMessage(adminId,
                    `🚨 <b>NOUVELLE COMMANDE !</b>\n\n` +
                    `👤 Client : ${ctx.from.first_name} (@${ctx.from.username})\n` +
                    `📦 Produit : ${productList}\n` +
                    `📍 Adresse : ${pending.address}\n` +
                    (pending.scheduled_at ? `🕒 <b>PLANIFIÉ : ${pending.scheduled_at}</b>\n` : `🚀 <b>ASAP</b>\n`) +
                    `💰 Total : ${finalPrice.toFixed(2)}€\n` +
                    `🔑 ID : <code>${order.id}</code>\n\n` +
                    `Choisissez un livreur ou gérez la commande :`,
                    {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Gérer / Assigner', `admin_order_view_${order.id}`)]])
                    }
                ).catch(() => { });
            }
        }

        // Notifier TOUS les livreurs (pas seulement les "disponibles" — c'est eux qui choisissent)
        try {
            const allLivreurs = await getAllLivreurs();
            for (const l of allLivreurs) {
                if (l.platform_id) {
                    bot.telegram.sendMessage(l.platform_id,
                        notificationText,
                        {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([[Markup.button.callback('📦 Voir les commandes', 'show_available_orders')]])
                        }
                    ).catch(() => { });
                }
            }
        } catch (e) {
            console.error("Livreur notification failed:", e.message);
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

    // Helper menu livreur additionnel si besoin
    bot.action('tracking_info', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        await safeEdit(ctx,
            `${settings.ui_icon_livreur} <b>Suivi en direct</b>\n\n` +
            `Pour que le client puisse suivre votre arrivée :\n\n` +
            `1. Cliquez sur le trombone (📎) ou (+) dans cette conversation\n` +
            `2. Sélectionnez <b>Lieu</b> ou <b>Position</b>\n` +
            `3. Choisissez <b>Partager ma position en direct</b> (Live Location)\n` +
            `4. Sélectionnez la durée (ex: 1 heure)\n\n` +
            `Le bot détectera automatiquement vos déplacements pour informer le client.`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]])
        );
    });

    bot.command('dispo', async (ctx) => {
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return safeEdit(ctx, '❌ Vous n\'êtes pas livreur.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'main_menu')]]));

        await safeEdit(ctx,
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
        const city = user?.current_city || user?.data?.current_city || 'Non défini';
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user ? (user.first_name || 'Inconnu') : ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvailable ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const keyboard = getLivreurMenuKeyboard(settings, user || { is_available: isAvailable, data: { is_available: isAvailable } });
        await safeEdit(ctx, text, keyboard);

        // 5. Cleanup bouton "Démarrer"
        ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });
    });

    bot.command('ma_position', async (ctx) => {
        const city = ctx.message.text.split(' ')[1];
        if (!city) return safeEdit(ctx, '❌ Usage: /ma_position [ville]', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));

        await updateLivreurPosition(`telegram_${ctx.from.id}`, city.toLowerCase());
        await safeEdit(ctx, `📍 Secteur mis à jour : ${city.toUpperCase()}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Livreur', 'livreur_menu')]]));
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

        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        const { getLivreurMenuKeyboard } = require('./start');

        const city = user?.current_city || user?.data?.current_city || cityName || 'Non défini';
        const isAvail = user?.is_available || user?.data?.is_available;
        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user?.first_name || ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n` +
            `Que voulez-vous faire ?`;

        const opts = getLivreurMenuKeyboard(settings, user);
        return await safeEdit(ctx, text, opts);
    });

    bot.action('show_available_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const orders = await getAvailableOrders();
        const settings = await getAppSettings();

        // Que les ASAP
        const asap = orders.filter(o => !o.scheduled_at);

        let text = `🚀 <b>Commandes disponibles (ASAP)</b>\n\n`;
        const buttons = [];

        if (asap.length > 0) {
            asap.forEach(o => {
                const addr = o.address ? o.address.substring(0, 15) : '?';
                buttons.push([Markup.button.callback(`🚀 ${o.product_name} - ${o.total_price}€ (${addr})`, `take_order_${o.id}`)]);
            });
        } else {
            text = '📭 Aucune commande immédiate (ASAP) disponible.';
        }

        buttons.push([Markup.button.callback('🔄 Rafraîchir', 'show_available_orders')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('show_planned_orders', async (ctx) => {
        await ctx.answerCbQuery();
        const orders = await getAvailableOrders();

        const planned = orders.filter(o => o.scheduled_at);

        let text = `🗓 <b>Commandes Planifiées</b>\n\nVoici les créneaux réservés par les clients :\n`;
        const buttons = [];

        if (planned.length > 0) {
            planned.forEach(o => {
                const addr = o.address ? o.address.substring(0, 15) : '?';
                buttons.push([Markup.button.callback(`🗓 ${o.scheduled_at} - ${o.product_name} (${addr})`, `take_order_${o.id}`)]);
            });
        } else {
            text = '📭 Aucune commande planifiée disponible pour le moment.';
        }

        buttons.push([Markup.button.callback('🔄 Rafraîchir', 'show_planned_orders')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^take_order_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);

        if (!order || order.status !== 'pending') return safeEdit(ctx, '❌ Cette commande n\'est plus disponible.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'show_available_orders')]]));

        await updateOrderStatus(orderId, 'taken', {
            livreur_id: `telegram_${ctx.from.id}`,
            livreur_name: ctx.from.first_name
        });

        const settings = ctx.state.settings;
        await safeEdit(ctx,
            `${settings.ui_icon_success} <b>Commande #${orderId.substring(0, 5)} acceptée !</b>\n\n` +
            `📦 Produit : <b>${order.product_name}</b>\n` +
            `📍 Adresse : <code>${order.address}</code>\n` +
            (order.scheduled_at ? `🕒 <b>PRÉVU POUR : ${order.scheduled_at}</b>\n\n` : `🕒 Dès que possible\n\n`) +
            `💰 Total à encaisser : <b>${order.total_price}€</b>\n\n` +
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

        if (!order) {
            return safeEdit(ctx, `❌ Commande introuvable.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu', 'livreur_menu')]]));
        }

        const settings = await getAppSettings();

        await updateOrderStatus(orderId, 'delivered', {
            livreur_id: `telegram_${ctx.from.id}`,
            livreur_name: ctx.from.first_name
        });
        await incrementOrderCount(`telegram_${ctx.from.id}`);

        await safeEdit(ctx, `✅ Commande <b>#${orderId.substring(0, 5)}</b> marquée comme LIVRÉE !\nFélicitations pour votre livraison.`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu Livreur', 'livreur_menu')]])
        });

        // Notifier client + Feedback
        if (order.user_id) {
            bot.telegram.sendMessage(order.user_id.replace('telegram_', ''),
                `✅ <b>Votre commande #${orderId.substring(0, 5)} a été livrée !</b>\n\n` +
                `Merci de votre confiance et à bientôt chez ${settings.bot_name} !`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('⭐️ Laisser un avis / Commentaire', `feedback_start_${orderId}`)]
                    ])
                }
            ).catch(() => { });
        }
    });

    bot.action(/^feedback_start_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🌟 <b>Votre avis nous intéresse !</b>\n\n` +
            `Comment s'est passée votre livraison ?\n` +
            `Notez votre expérience :`,
            Markup.inlineKeyboard([
                [Markup.button.callback('⭐️⭐️⭐️⭐️⭐️ (Excellent)', `feedback_rate_${orderId}_5`)],
                [Markup.button.callback('⭐️⭐️⭐️⭐️ (Très bien)', `feedback_rate_${orderId}_4`)],
                [Markup.button.callback('⭐️⭐️⭐️ (Bien)', `feedback_rate_${orderId}_3`)],
                [Markup.button.callback('⭐️ (Moyen/Mauvais)', `feedback_rate_${orderId}_1`)],
            ])
        );
    });

    bot.action(/^feedback_rate_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, rate] = ctx.match;
        await ctx.answerCbQuery();

        const { setPendingFeedback } = require('../services/database');
        await setPendingFeedback(`telegram_${ctx.from.id}`, orderId, rate);

        await safeEdit(ctx, `✍️ <b>Dernière étape</b>\n\nEnvoyez un petit commentaire (en un seul message) pour expliquer votre note :`);
    });

    // Capture du commentaire feedback
    bot.on('message', async (ctx, next) => {
        const { getAndClearPendingFeedback, saveFeedback } = require('../services/database');
        const pending = await getAndClearPendingFeedback(`telegram_${ctx.from.id}`);

        if (pending) {
            const { orderId, rate } = pending;
            const text = ctx.message.text;
            await saveFeedback(orderId, parseInt(rate), text);

            // Alerte aux admins et au livreur
            try {
                const { getAppSettings, getOrder } = require('../services/database');
                const [settings, order] = await Promise.all([getAppSettings(), getOrder(orderId)]);

                if (settings && order) {
                    const stars = '⭐'.repeat(parseInt(rate));
                    const feedbackMsg = `💬 <b>NOUVEAU FEEDBACK !</b>\n\n` +
                        `👤 Client : ${ctx.from.first_name}\n` +
                        `🔑 Commande ID : <code>${orderId}</code>\n` +
                        `🌟 Note : ${stars} (${rate}/5)\n` +
                        `📝 Commentaire : <i>${text}</i>`;

                    // Notifier les admins
                    if (settings.admin_telegram_id) {
                        const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
                        for (const adminId of adminIds) {
                            ctx.telegram.sendMessage(adminId, feedbackMsg, { parse_mode: 'HTML' }).catch(() => { });
                        }
                    }

                    // Notifier le livreur si assigné
                    if (order.livreur_id) {
                        ctx.telegram.sendMessage(order.livreur_id, `👏 <b>Félicitations !</b>\n\nUn client a laissé une note pour votre livraison :\n\n${stars}\n"<i>${text}</i>"`, { parse_mode: 'HTML' }).catch(() => { });
                    }
                }
            } catch (e) {
                console.error("Error notifying feedback:", e.message);
            }

            const thankMsg = await ctx.reply('🙏 Merci pour votre retour ! Votre avis a bien été enregistré.');

            // Après 35s : vider et réafficher le menu principal
            setTimeout(async () => {
                try {
                    // Supprimer le message de remerciement et le commentaire de l'utilisateur
                    await ctx.deleteMessage(thankMsg.message_id).catch(() => { });
                    await ctx.deleteMessage(ctx.message.message_id).catch(() => { });

                    // Réafficher le menu principal
                    const { getAppSettings, getUser } = require('../services/database');
                    const { getMainMenuKeyboard } = require('./start');
                    const settings = await getAppSettings();
                    const user = await getUser(`telegram_${ctx.from.id}`);
                    const menuText = `📋 <b>Menu principal</b>`;
                    const keyboard = getMainMenuKeyboard(settings, user);
                    await ctx.telegram.sendMessage(ctx.chat.id, menuText, { parse_mode: 'HTML', ...keyboard });
                } catch (e) { console.error('Post-feedback cleanup error:', e.message); }
            }, 35000);

            return;
        }
        await next();
    });

    bot.action('livreur_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user || !user.is_livreur) return safeEdit(ctx, '❌ Accès refusé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));

        const { getLivreurMenuKeyboard } = require('./start');
        const city = user.current_city || user.data?.current_city || 'Non défini';
        const isAvail = user.is_available || user.data?.is_available;

        const { getLivreurOrders } = require('../services/database');
        const activeOrders = await getLivreurOrders(`telegram_${ctx.from.id}`);

        let text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user.first_name || ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n`;

        if (activeOrders.length > 0) {
            text += `🚨 <b>VOUS AVEZ ${activeOrders.length} COMMANDE(S) EN COURS !</b>\n\n`;
            activeOrders.forEach(o => {
                text += `📦 #${o.id.substring(0, 5)} - ${o.address}\n`;
            });
            text += `\n<i>Cliquez sur "Mes livraisons en cours" pour les gérer.</i>\n\n`;
        }

        text += `Que voulez-vous faire ?`;

        const opts = getLivreurMenuKeyboard(settings, user, activeOrders.length > 0);
        await safeEdit(ctx, text, opts);
    });

    bot.action('active_deliveries', async (ctx) => {
        await ctx.answerCbQuery();
        const { getLivreurOrders } = require('../services/database');
        const orders = await getLivreurOrders(`telegram_${ctx.from.id}`);

        if (orders.length === 0) {
            return safeEdit(ctx, '📭 Aucune livraison en cours.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
        }

        const settings = await getAppSettings();
        let text = `🚚 <b>Livraisons en cours</b>\n\nCliquez sur une livraison pour la gérer :\n`;
        const buttons = orders.map(o => [Markup.button.callback(`#${o.id.substring(0, 5)} - ${o.product_name} (${o.address.substring(0, 15)}...)`, `view_active_${o.id}`)]);
        buttons.push([Markup.button.callback('◀️ Retour', 'livreur_menu')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^view_active_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        if (!order) return safeEdit(ctx, '❌ Commande non trouvée.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'main_menu')]]));

        const settings = await getAppSettings();
        let detailText = `📦 <b>Détails Livraison #${orderId.substring(0, 5)}</b>\n\n` +
            `📍 Adresse : <code>${order.address}</code>\n` +
            `💰 À encaisser : <b>${order.total_price}€</b>\n\n`;

        if (order.scheduled_at) {
            detailText = `🗓 <b>LIVRAISON PLANIFIÉE</b>\n` +
                `🕒 Prévu pour : <b>${order.scheduled_at}</b>\n\n` + detailText;
        } else {
            detailText = `🚀 <b>LIVRAISON IMMÉDIATE (ASAP)</b>\n\n` + detailText;
        }

        await safeEdit(ctx, detailText + `Utilisez les boutons ci-dessous pour avancer :`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏰ Arrivée -1h', `notify_${orderId}_1h`)],
                    [Markup.button.callback('⏳ 30 min', `notify_${orderId}_30m`), Markup.button.callback('⏳ 10 min', `notify_${orderId}_10m`)],
                    [Markup.button.callback('⚡ 5 min', `notify_${orderId}_5m`), Markup.button.callback('📍 Arrivé', `notify_${orderId}_here`)],
                    [Markup.button.callback(`${settings.ui_icon_success} MARQUER COMME LIVRÉE`, `finish_${orderId}`)],
                    [Markup.button.callback('◀️ Retour', 'active_deliveries')]
                ])
            }
        );
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
            console.log(`[LIVREUR] Historique pour: ${userId}`);
            const deliveries = await getLivreurHistory(userId);
            console.log(`[LIVREUR] ${deliveries.length} livraisons trouvées.`);

            if (deliveries.length === 0) {
                return safeEdit(ctx, `📭 Votre historique de livraison est vide.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]]));
            }

            let text = `📊 <b>Mon historique de livraisons</b>\n\n`;
            let totalEarned = 0;

            deliveries.forEach((d, i) => {
                // Parsing date Supabase simple
                const dateStr = d.created_at ? new Date(d.created_at).toLocaleDateString('fr-FR') : 'Date inconnue';
                text += `${i + 1}. #${d.id.substring(0, 5)} - ${d.product_name} (${d.total_price}€)\n` +
                    `📅 ${dateStr} - 📍 ${(d.address || 'N/A').substring(0, 20)}...\n\n`;
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
            const { updateLivreurPosition } = require('../services/database');

            await updateLivreurPosition(docId, city);

            // Nettoyage input
            await ctx.deleteMessage().catch(() => { });

            const settings = ctx.state.settings;
            const user = await getUser(docId);
            const { getLivreurMenuKeyboard: getKB } = require('./start');

            const text = `✅ <b>Secteur validé : ${city.toUpperCase()}</b>\n\n` +
                `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
                `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : city.toUpperCase()}</b>\n` +
                `🔘 Statut : <b>${user.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>`;

            await safeEdit(ctx, text, getKB(settings, user));
            delete ctx.state.awaiting_city;
            return;
        }
        await next();
    });
}

module.exports = {
    setupOrderSystem,
    userCarts,
    pendingOrders,
    awaitingAddressDetails,
    pendingOrderConfirmation
};
