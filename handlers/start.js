const { Markup } = require('telegraf');
const { registerUser, getUser, incrementDailyStat, getAppSettings } = require('../services/database');

// Helper: essaye d'éditer le message, sinon envoie un nouveau
async function safeEdit(ctx, text, opts) {
    try {
        await safeEdit(ctx, text, opts);
    } catch (e) {
        await ctx.replyWithHTML(text, opts.reply_markup ? { reply_markup: opts.reply_markup } : undefined);
    }
}

/**
 * Enregistre les handlers pour la commande /start
 */
function setupStartHandler(bot) {
    // Map pour gérer la saisie manuelle d'un code parrain
    const pendingReferralInput = new Map();

    bot.command('start', async (ctx) => {
        try {
            const user = ctx.from;
            const settings = await getAppSettings();

            // Vérifier si un code de parrainage est dans le payload (format complet: ref_telegram_xxx_CODE)
            let referrerId = null;
            const payload = ctx.message.text.split(' ')[1];
            if (payload && payload.startsWith('ref_')) {
                // On passe le code complet — la DB cherchera par referral_code
                referrerId = payload;
                // Empêcher l'auto-parrainage en cherchant son propre ID dans le code
                if (payload.includes(`_${user.id}_`)) referrerId = null;
            }

            // Enregistrer l'utilisateur (sera chiffré en DB)
            const { isNew, user: registeredUser } = await registerUser(user, 'telegram', referrerId);

            await incrementDailyStat('start_commands');

            if (isNew) {
                await ctx.replyWithHTML(
                    `✨ <b>Bienvenue sur ${settings.bot_name}, ${user.first_name} !</b>\n\n` +
                    `${settings.welcome_message}\n\n` +
                    `📋 <b>Votre profil :</b>\n` +
                    `├ 👤 Nom : <b>${user.first_name}</b>\n` +
                    `├ 🆔 ID : <code>${user.id}</code>\n` +
                    `└ 📅 Inscrit : <b>Aujourd'hui</b>\n\n` +
                    (referrerId ? `🎉 <i>Vous avez été invité via un lien de parrainage !</i>\n\n` : '') +
                    `🔗 <b>Votre lien de parrainage :</b>\n` +
                    `<code>https://t.me/${ctx.botInfo.username}?start=${registeredUser.referral_code}</code>\n\n` +
                    `Partagez ce lien pour inviter vos amis ! 🚀`,
                    getMainMenuKeyboard(settings, registeredUser)
                );

                // Si pas de code parrain dans le lien → demander manuellement
                if (!referrerId) {
                    pendingReferralInput.set(`telegram_${user.id}`, true);
                    await ctx.reply(
                        '🎁 Avez-vous un code parrainage ?\n' +
                        'Si oui, tapez-le maintenant (commençant par ref_...).\n' +
                        'Sinon, ignorez ce message et utilisez le menu.'
                    );
                }
            } else {
                // Nettoyer le pending si revient
                pendingReferralInput.delete(`telegram_${user.id}`);

                // ========== SI LIVREUR → MENU LIVREUR DÉDIÉ ==========
                if (registeredUser.is_livreur) {
                    await ctx.replyWithHTML(
                        `${settings.ui_icon_livreur} <b>Bienvenue, livreur ${user.first_name} !</b>\n\n` +
                        `📍 Secteur : <b>${registeredUser.current_city ? registeredUser.current_city.toUpperCase() : 'Non défini'}</b>\n` +
                        `🔘 Statut : <b>${registeredUser.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>\n\n` +
                        `Que voulez-vous faire ?`,
                        getLivreurMenuKeyboard(settings, registeredUser)
                    );
                } else {
                    await ctx.replyWithHTML(
                        `👋 <b>Ravi de vous revoir, ${user.first_name} !</b>\n\n` +
                        `Vous êtes déjà membre du ${settings.bot_name}.`,
                        getMainMenuKeyboard(settings, registeredUser)
                    );
                }
            }
        } catch (error) {
            console.error('❌ Erreur /start:', error);
            await ctx.reply('❌ Une erreur est survenue. Veuillez réessayer avec /start');
        }
    });

    bot.action('private_contact', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
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
        const settings = await getAppSettings();
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
        await ctx.answerCbQuery();

        const settings = await require('../services/database').getAppSettings();
        const ptsExchange = settings.points_exchange || 10;
        const chunkCredit = 10;
        const chunkPts = ptsExchange * chunkCredit;

        const userRef = require('../services/database').db.collection('bot_users').doc(`telegram_${ctx.from.id}`);
        const userDoc = await userRef.get();
        if (userDoc.exists && userDoc.data().points >= chunkPts) {
            await userRef.update({
                points: require('../services/database').incr(-chunkPts),
                wallet_balance: require('../services/database').incr(chunkCredit)
            });
            await ctx.reply(`🎉 <b>Félicitations !</b> Vous avez échangé ${chunkPts} points contre ${chunkCredit}€ dans votre portefeuille.`, { parse_mode: 'HTML' });
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: { ...ctx.callbackQuery, data: 'my_referrals' }
            }); // Refresh profile
        } else {
            return ctx.reply(`❌ Vous n'avez pas assez de points (${chunkPts} pts minimum).`);
        }
    });

    bot.action('main_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const user = await getUser(`telegram_${ctx.from.id}`);

        // Si livreur → renvoyer vers le menu livreur
        if (user && user.is_livreur) {
            return ctx.replyWithHTML(
                `${settings.ui_icon_livreur} <b>${settings.label_livreur_space}</b>\n\n` +
                `📍 Secteur : <b>${user.current_city ? user.current_city.toUpperCase() : 'Non défini'}</b>\n` +
                `🔘 Statut : <b>${user.is_available ? settings.ui_icon_success + ' DISPONIBLE' : settings.ui_icon_error + ' INDISPONIBLE'}</b>`,
                getLivreurMenuKeyboard(settings, user)
            );
        }

        try {
            await safeEdit(ctx, `📋 <b>Menu principal</b>`, {
                parse_mode: 'HTML',
                ...getMainMenuKeyboard(settings, user)
            });
        } catch (e) {
            await ctx.replyWithHTML(`📋 <b>Menu principal</b>`, getMainMenuKeyboard(settings, user));
        }
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
        await ctx.replyWithHTML(
            `📡 <b>Comment activer le tracking ?</b>\n\n` +
            `Pour que le client puisse recevoir vos estimations d'arrivée :\n\n` +
            `1. Cliquez sur le trombonne (📎) ou (+) en bas.\n` +
            `2. Choisissez <b>Position</b> (ou Localisation).\n` +
            `3. Sélectionnez <b>Partager ma position en direct</b>.\n` +
            `4. Choisissez la durée (ex: 8 heures).\n\n` +
            `✅ Une fois activé, le bot enverra automatiquement des alertes (10 min / 5 min) à vos clients en fonction de vos déplacements !`
        );
    });

    bot.on('text', async (ctx, next) => {
        const userId = `telegram_${ctx.from.id}`;
        const inputText = ctx.message.text.trim();

        // Si pas en attente de code parrain, passer au handler suivant
        if (!pendingReferralInput.has(userId)) return next();
        // Si le texte ne commence pas par ref_, c'est peut-être l'adresse -> passer au suivant
        if (!inputText.startsWith('ref_')) {
            pendingReferralInput.delete(userId);
            return next();
        }

        pendingReferralInput.delete(userId);

        try {
            const db = require('../services/database');
            const snap = await db.db.collection('bot_users').where('referral_code', '==', inputText).limit(1).get();
            if (!snap.empty && snap.docs[0].id !== userId) {
                const referrerDoc = snap.docs[0];
                await referrerDoc.ref.update({ referral_count: db.incr() });
                await db.db.collection('bot_users').doc(userId).update({ referred_by: referrerDoc.id });
                await db.db.collection('referrals').add({
                    referrer_id: referrerDoc.id,
                    referred_id: userId,
                    created_at: db.ts()
                });
                return ctx.reply('🎉 Code parrainage validé ! Votre parrain a été crédité. Vous gagnerez chacun un bonus à votre première commande.');
            } else {
                return ctx.reply('❌ Code parrainage invalide ou déjà utilisé.');
            }
        } catch (e) {
            console.error('Referral code error:', e);
            return ctx.reply('❌ Erreur lors de la validation du code. Réessayez plus tard.');
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
        buttons.push([Markup.button.callback(`${settings.ui_icon_livreur} ${settings.label_livreur_space}`, 'livreur_menu')]);
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
    const dispoBtn = user.is_available
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
