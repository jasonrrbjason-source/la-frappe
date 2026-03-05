const { Markup } = require('telegraf');
const { registerUser, getUser, incrementDailyStat, getAppSettings, addMessageToTrack, getLastMenuId } = require('../services/database');
const { safeEdit } = require('../services/utils');

/**
 * Enregistre les handlers pour la commande /start
 */
function setupStartHandler(bot) {
    // Map pour gérer la saisie manuelle d'un code parrain
    const pendingReferralInput = new Map();

    bot.command('start', async (ctx) => {
        try {
            const user = ctx.from;
            const settings = ctx.state.settings;
            const docId = `telegram_${user.id}`;

            // L'envoi du menu est géré par safeEdit (transition douce)
            // L'effacement du /start entrant est géré par le middleware global

            // Vérifier si un code de parrainage
            let referrerId = null;
            const payload = ctx.message.text.split(' ')[1];
            if (payload && payload.startsWith('ref_')) {
                referrerId = payload;
                if (payload.includes(`_${user.id}_`)) referrerId = null;
            }

            const { isNew, user: registeredUser } = await registerUser(user, 'telegram', referrerId);
            ctx.state.user = registeredUser; // Update state with registered user info
            await incrementDailyStat('start_commands');

            let welcomeText = "";
            if (isNew) {
                welcomeText = `✨ <b>Bienvenue sur ${settings.bot_name}, ${user.first_name} !</b>\n\n` +
                    `${settings.welcome_message}\n\n` +
                    `📍 <i>En utilisant ce service, vous acceptez d'être localisé tacitement.</i>\n\n` +
                    `🔗 <b>Votre lien de parrainage :</b>\n` +
                    `<code>https://t.me/${ctx.botInfo.username}?start=${registeredUser.referral_code}</code>`;

                if (!referrerId) pendingReferralInput.set(docId, true);
            } else {
                welcomeText = registeredUser.is_livreur
                    ? `${settings.ui_icon_livreur} <b>Bienvenue, livreur ${user.first_name} !</b>\n\n📍 Secteur : <b>${registeredUser.current_city ? registeredUser.current_city.toUpperCase() : 'Non défini'}</b>\n🔘 Statut : <b>${registeredUser.is_available ? 'DISPONIBLE' : 'INDISPONIBLE'}</b>`
                    : `👋 <b>Ravi de vous revoir, ${user.first_name} !</b>\n\nVous êtes déjà membre du ${settings.bot_name}.`;
            }

            const keyboard = registeredUser.is_livreur ? getLivreurMenuKeyboard(settings, registeredUser) : getMainMenuKeyboard(settings, registeredUser);
            await safeEdit(ctx, welcomeText, keyboard);

            // Forcer le bouton "Menu" au lieu de "Démarrer"
            ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });

        } catch (error) {
            console.error('❌ Erreur /start:', error);
        }
    });

    bot.action('private_contact', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state.settings;
        const buttons = [];
        if (settings.private_contact_url) {
            buttons.push([Markup.button.url('💬 Ouvrir le contact', settings.private_contact_url)]);
        } else {
            buttons.push([Markup.button.callback('⚠️ Lien non configuré', 'main_menu')]);
        }
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);
        await safeEdit(ctx, `${settings.ui_icon_contact} <b>${settings.label_contact}</b>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action('channel_link', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state.settings;
        const buttons = [];
        if (settings.channel_url) {
            buttons.push([Markup.button.url('📢 Rejoindre le canal', settings.channel_url)]);
        } else {
            buttons.push([Markup.button.callback('⚠️ Lien non configuré', 'main_menu')]);
        }
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);
        await safeEdit(ctx, `${settings.ui_icon_channel} <b>${settings.label_channel}</b>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action('welcome_message', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        await safeEdit(ctx,
            `${settings.ui_icon_welcome} <b>${settings.label_welcome}</b>\n\n${settings.welcome_message}`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au menu', 'main_menu')]])
            }
        );
    });

    bot.action('my_referrals', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await getUser(`telegram_${ctx.from.id}`);
        if (!user) return ctx.reply('❌ Erreur : Profil non trouvé. Relancez /start');

        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=${user.referral_code}`;

        const settings = await getAppSettings();
        const ptsExchange = settings.points_exchange || 10;
        const ptsRatio = settings.points_ratio || 1;
        const refBonus = settings.ref_bonus || 5;
        const chunkCredit = 10;
        const chunkPts = ptsExchange * chunkCredit;

        await safeEdit(ctx,
            `${settings.ui_icon_profile} <b>${settings.label_profile}</b>\n\n` +
            `${settings.ui_icon_wallet} Solde Portefeuille : <b>${(user.wallet_balance || 0).toFixed(2)}€</b>\n` +
            `${settings.ui_icon_points} Points Fidélité : <b>${user.points || 0} pts</b>\n\n` +
            `👥 Amis parrainés : <b>${user.referral_count || 0}</b>\n` +
            `🛍️ Commandes totales : <b>${user.order_count || 0}</b>\n\n` +
            `🔗 <b>Votre lien personnel :</b>\n` +
            `<code>${refLink}</code>\n\n` +
            `<i>Partagez ce lien ! À votre première commande, vous et votre parrain gagnerez <b>${refBonus}€</b> de crédit. Vous cumulez aussi ${ptsRatio} point(s) par euro d'achat.\n(${chunkPts} points = ${chunkCredit}€ de crédit)</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    ...(user.points >= chunkPts ? [[Markup.button.callback(`🎁 Échanger ${chunkPts} pts contre ${chunkCredit}€`, 'exchange_points')]] : []),
                    [Markup.button.callback('◀️ Retour au menu', 'main_menu')]
                ])
            }
        );
    });

    bot.action('exchange_points', async (ctx) => {
        const settings = await require('../services/database').getAppSettings();
        const ptsExchange = settings.points_exchange || 10;
        const chunkCredit = 10;
        const chunkPts = ptsExchange * chunkCredit;

        const docId = `telegram_${ctx.from.id}`;
        const userDoc = await getUser(docId);

        if (userDoc && userDoc.points >= chunkPts) {
            const { supabase, COL_USERS } = require('../services/database');
            await supabase.from(COL_USERS).update({
                points: userDoc.points - chunkPts,
                wallet_balance: (userDoc.wallet_balance || 0) + chunkCredit
            }).eq('id', docId);
            await ctx.answerCbQuery(`🎉 Succès ! +${chunkCredit}€ ajoutés.`, { show_alert: true });
        } else {
            return ctx.answerCbQuery(`❌ Points insuffisants (${chunkPts} pts requis).`, { show_alert: true });
        }

        // Simuler le clic sur le profil pour rafraîchir sans handleUpdate
        const user = await getUser(docId);
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=${user.referral_code}`;
        const refBonus = settings.ref_bonus || 5;
        const ptsRatio = settings.points_ratio || 1;

        const text = `${settings.ui_icon_profile} <b>${settings.label_profile}</b>\n\n` +
            `${settings.ui_icon_wallet} Solde Portefeuille : <b>${(user.wallet_balance || 0).toFixed(2)}€</b>\n` +
            `${settings.ui_icon_points} Points Fidélité : <b>${user.points || 0} pts</b>\n\n` +
            `👥 Amis parrainés : <b>${user.referral_count || 0}</b>\n` +
            `🛍️ Commandes totales : <b>${user.order_count || 0}</b>\n\n` +
            `🔗 <b>Votre lien personnel :</b>\n` +
            `<code>${refLink}</code>\n\n` +
            `<i>Partagez ce lien ! À votre première commande, vous et votre parrain gagnerez <b>${refBonus}€</b> de crédit. Vous cumulez aussi ${ptsRatio} point(s) par euro d'achat.\n(${chunkPts} points = ${chunkCredit}€ de crédit)</i>`;

        const buttons = [
            ...(user.points >= chunkPts ? [[Markup.button.callback(`🎁 Échanger ${chunkPts} pts contre ${chunkCredit}€`, 'exchange_points')]] : []),
            [Markup.button.callback('◀️ Retour au menu', 'main_menu')]
        ];

        return await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('main_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);

        let text = `📋 <b>Menu principal</b>`;
        let keyboard = getMainMenuKeyboard(settings, user);

        // Si livreur → menu spécial
        if (user && user.is_livreur) {
            text = `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
                `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
                `🔘 Statut : <b>${user.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>`;
            keyboard = getLivreurMenuKeyboard(settings, user);
        }

        await safeEdit(ctx, text, keyboard);
    });

    // ========== GESTION GPS / LOCALISATION ==========
    bot.on('location', async (ctx) => {
        const userId = `telegram_${ctx.from.id}`;
        const loc = ctx.message.location;
        if (!loc) return;

        try {
            const { saveUserLocation } = require('../services/database');
            // Sauvegarder les coordonnées
            await saveUserLocation(userId, loc.latitude, loc.longitude);

            await ctx.reply('✅ Position enregistrée. Merci !', Markup.removeKeyboard());

            // On pourrait faire un reverse geocoding ici pour avoir la ville exacte si besoin
            // Pour l'instant on garde les coordonnées pour le tracking livreur
        } catch (e) {
            console.error('Location error:', e);
        }
    });

    // ========== GESTION CODE PARRAIN MANUEL ==========
    bot.action('tracking_info', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `📡 <b>Comment activer le tracking ?</b>\n\n` +
            `Pour que le client puisse recevoir vos estimations d'arrivée :\n\n` +
            `1. Cliquez sur le trombonne (📎) ou (+) en bas.\n` +
            `2. Choisissez <b>Position</b> (ou Localisation).\n` +
            `3. Sélectionnez <b>Partager ma position en direct</b>.\n` +
            `4. Choisissez la durée (ex: 8 heures).\n\n` +
            `✅ Une fois activé, le bot enverra automatiquement des alertes (10 min / 5 min) à vos clients en fonction de vos déplacements !`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'livreur_menu')]])
        );
    });

    bot.on('text', async (ctx, next) => {
        const docId = `telegram_${ctx.from.id}`;
        const inputText = ctx.message.text.trim();

        // Si pas en attente de code parrain, passer au handler suivant
        if (!pendingReferralInput.has(docId)) return next();
        // Si le texte ne commence pas par ref_, c'est peut-être l'adresse -> passer au suivant
        if (!inputText.startsWith('ref_')) {
            pendingReferralInput.delete(docId);
            return next();
        }

        pendingReferralInput.delete(docId);

        try {
            const db = require('../services/database');
            const { supabase, COL_USERS, COL_REFERRALS } = db;
            const { data: snap } = await supabase.from(COL_USERS).select('*').eq('referral_code', inputText).limit(1);

            if (snap && snap.length > 0 && snap[0].id !== docId) {
                const referrerDoc = snap[0];
                await supabase.from(COL_USERS).update({ referral_count: referrerDoc.referral_count + 1 }).eq('id', referrerDoc.id);
                await supabase.from(COL_USERS).update({ referred_by: referrerDoc.id }).eq('id', docId);
                await supabase.from(COL_REFERRALS).insert([{
                    id: `${Date.now()}-${Math.random()}`,
                    referrer_id: referrerDoc.id,
                    referred_id: docId,
                    created_at: db.ts()
                }]);
                return safeEdit(ctx, '🎉 Code parrainage validé ! Votre parrain a été crédité. Vous gagnerez chacun un bonus à votre première commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            } else {
                return safeEdit(ctx, '❌ Code parrainage invalide ou déjà utilisé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            }
        } catch (e) {
            console.error('Referral code error:', e);
            return safeEdit(ctx, '❌ Erreur lors de la validation du code. Réessayez plus tard.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }
    });
}

function getMainMenuKeyboard(settings, user = null) {
    const buttons = [
        [Markup.button.callback(`${settings.ui_icon_catalog} ${settings.label_catalog}`, 'view_catalog')],
        [Markup.button.callback(`${settings.ui_icon_orders} ${settings.label_my_orders}`, 'my_orders')],
        [Markup.button.callback(`${settings.ui_icon_contact} ${settings.label_contact}`, 'private_contact')],
        [Markup.button.callback(`${settings.ui_icon_channel} ${settings.label_channel}`, 'channel_link')],
        [Markup.button.callback(`${settings.ui_icon_welcome} ${settings.label_welcome}`, 'welcome_message')],
        [Markup.button.callback(`${settings.ui_icon_profile} ${settings.label_profile}`, 'my_referrals')],
    ];

    if (user && user.is_livreur) {
        buttons.push([Markup.button.callback(`${settings.ui_icon_livreur} ${settings.label_livreur}`, 'livreur_menu')]);
    }

    // Boutons Admin
    if (user && settings.admin_telegram_id) {
        const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
        if (adminIds.includes(String(user.platform_id))) {
            buttons.push([Markup.button.callback(`${settings.ui_icon_admin} ${settings.label_admin_bot}`, 'admin_menu')]);
            // On cache Dashboard Web si pas d'URL configurée manuellement (pour épurer le bot)
            if (settings.dashboard_url && settings.dashboard_url.startsWith('http')) {
                buttons.push([Markup.button.webApp(`${settings.ui_icon_web} ${settings.label_admin_web}`, settings.dashboard_url)]);
            }
        }
    }

    return Markup.inlineKeyboard(buttons);
}

function getLivreurMenuKeyboard(settings, user) {
    const isAvail = user.is_available || (user.data && user.data.is_available);
    const dispoBtn = isAvail
        ? Markup.button.callback(`${settings.ui_icon_error} Passer Indisponible`, 'set_dispo_false')
        : Markup.button.callback(`${settings.ui_icon_success} Passer Disponible`, 'set_dispo_true');

    const buttons = [
        [dispoBtn],
        [Markup.button.callback(`${settings.ui_icon_orders} Commandes disponibles`, 'show_city_orders')],
        [Markup.button.callback('📍 Changer de secteur', 'change_city')],
        [Markup.button.callback('📡 Tracking Live (Aide)', 'tracking_info')],
        [Markup.button.callback(`${settings.ui_icon_stats} Mon historique livraisons`, 'my_deliveries')],
        [Markup.button.callback('🛒 Mode Client (commander)', 'client_menu')],
    ];

    // Bouton Admin si le livreur est aussi admin
    if (user && settings.admin_telegram_id) {
        const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
        if (adminIds.includes(String(user.platform_id))) {
            buttons.push([Markup.button.callback(`${settings.ui_icon_admin} ${settings.label_admin_bot}`, 'admin_menu')]);
        }
    }

    return Markup.inlineKeyboard(buttons);
}

module.exports = { setupStartHandler, getLivreurMenuKeyboard };
