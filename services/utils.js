const { getLastMenuId, addMessageToTrack, getUser } = require('./database');

/**
 * L'Unique porte de sortie pour les menus du bot.
 * Garantit qu'un seul message de menu existe à la fois (Flux Constant).
 */
async function safeEdit(ctx, text, opts = {}) {
    const isGroup = ctx.chat.type !== 'private';
    const trackId = isGroup ? `telegram_${ctx.chat.id}` : `telegram_${ctx.from.id}`;
    const chatId = ctx.chat.id;

    // Détection et extraction des médias
    const photo = opts.photo || null;
    const video = opts.video || null;
    const mediaGroup = opts.mediaGroup || null;
    delete opts.photo;
    delete opts.video;
    delete opts.mediaGroup;

    // Normalisation du clavier (Telegraf Markup vs Plain Object)
    let reply_markup = null;
    if (opts.reply_markup) {
        reply_markup = opts.reply_markup;
    } else if (opts.inline_keyboard) {
        reply_markup = opts;
    } else if (Array.isArray(opts)) {
        reply_markup = { inline_keyboard: opts };
    }

    const extra = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: reply_markup
    };

    try {
        const currentMsg = ctx.callbackQuery?.message;

        // --- TENTATIVE 1 : EDIT FLUIDE (Même type de message pour éviter l'évaporation) ---
        if (currentMsg) {
            const hasPhoto = !!currentMsg.photo;
            const hasVideo = !!currentMsg.video;
            const hasTextOnly = !hasPhoto && !hasVideo && !currentMsg.media_group_id;

            // CAS A : TEXTE -> TEXTE
            if (hasTextOnly && !photo && !video && !mediaGroup) {
                try {
                    await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    await addMessageToTrack(trackId, currentMsg.message_id).catch(() => { });
                    return;
                } catch (err) {
                    if (err.description && err.description.includes('message is not modified')) return;
                }
            }

            // CAS B : PHOTO -> PHOTO ou VIDEO -> VIDEO (Edit Media)
            if (((hasPhoto && photo) || (hasVideo && video)) && !mediaGroup) {
                try {
                    await ctx.telegram.editMessageMedia(chatId, currentMsg.message_id, null, {
                        type: photo ? 'photo' : 'video',
                        media: photo || video,
                        caption: text,
                        parse_mode: 'HTML'
                    }, { reply_markup: extra.reply_markup });
                    await addMessageToTrack(trackId, currentMsg.message_id).catch(() => { });
                    return;
                } catch (e) { /* fallback if edit fails */ }
            }
        }

        // --- TENTATIVE 2 : SEND PUIS DELETE (Évite le bouton "Start" et l'écran vide) ---

        // 1. Envoi du nouveau menu d'abord
        let newMsgs = [];
        if (mediaGroup && mediaGroup.length > 0) {
            const mediaWithCaption = mediaGroup.map((m, i) => ({
                ...m,
                caption: i === 0 ? text : '',
                parse_mode: 'HTML'
            }));
            const msgs = await ctx.replyWithMediaGroup(mediaWithCaption);
            if (Array.isArray(msgs)) msgs.forEach(m => newMsgs.push(m));

            const menuMsg = await ctx.replyWithHTML('<b>Options :</b>', extra);
            if (menuMsg) newMsgs.push(menuMsg);
        } else if (photo) {
            const m = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
            if (m) newMsgs.push(m);
        } else if (video) {
            const m = await ctx.replyWithVideo(video, { caption: text, ...extra });
            if (m) newMsgs.push(m);
        } else {
            const m = await ctx.replyWithHTML(text, extra);
            if (m) newMsgs.push(m);
        }

        // 2. Tracking des nouveaux messages
        for (const m of newMsgs) {
            await addMessageToTrack(trackId, m.message_id).catch(() => { });
        }

        // 3. Suppression de l'ancien menu APRES l'envoi (Transition douce)
        if (currentMsg) {
            await ctx.telegram.deleteMessage(chatId, currentMsg.message_id).catch(() => { });
        }

        // 4. Nettoyage profond des résidus
        const user = await getUser(trackId);
        if (user) {
            if (user.last_menu_id && (!currentMsg || user.last_menu_id !== currentMsg.message_id)) {
                await ctx.telegram.deleteMessage(chatId, user.last_menu_id).catch(() => { });
            }
            if (user.tracked_messages && user.tracked_messages.length > 0) {
                const toClean = user.tracked_messages.slice(-15);
                const newIds = newMsgs.map(m => m.message_id);
                for (const mid of toClean) {
                    if (!newIds.includes(mid) && (!currentMsg || mid !== currentMsg.message_id)) {
                        await ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
                    }
                }
            }
        }

    } catch (e) {
        console.error('❌ SafeEdit CRITICAL error:', e.message);
        const lastResort = await ctx.replyWithHTML(text, extra).catch(() => { });
        if (lastResort) await addMessageToTrack(trackId, lastResort.message_id).catch(() => { });
    }
}

function debugLog(msg) {
    const fs = require('fs');
    const path = require('path');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_la_frappe.log'), line);
    } catch (e) { }
    console.log(msg);
}

module.exports = { safeEdit, debugLog };
