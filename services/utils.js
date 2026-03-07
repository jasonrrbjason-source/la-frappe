const { getLastMenuId, addMessageToTrack, getUser } = require('./database');

/**
 * L'Unique porte de sortie pour les menus du bot.
 * Garantit qu'un seul message de menu existe à la fois (Flux Constant).
 */
async function safeEdit(ctx, text, opts = {}) {
    const isGroup = ctx.chat.type !== 'private';
    const userId = isGroup ? `telegram_${ctx.chat.id}` : `telegram_${ctx.from.id}`;
    const chatId = ctx.chat.id;

    // Détection des médias
    let photo = opts.photo || null;
    const video = opts.video || null;

    // Normalisation du clavier
    let reply_markup = opts.reply_markup || (opts.inline_keyboard ? opts : (Array.isArray(opts) ? { inline_keyboard: opts } : null));
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    try {
        const currentMsg = ctx.callbackQuery?.message;
        const user = await getUser(userId); // Bypassing local state to get true last_menu_id

        // 1. TENTATIVE D'EDIT (Dynamic)
        if (currentMsg) {
            const hasMedia = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            // CASE: Text -> Text
            if (!hasMedia && !wantMedia) {
                try {
                    await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    await addMessageToTrack(userId, currentMsg.message_id);
                    return;
                } catch (e) { if (!e.description.includes('not modified')) throw e; }
            }

            // CASE: Media -> Media (Photo or Video)
            if (hasMedia && wantMedia) {
                try {
                    await ctx.telegram.editMessageMedia(chatId, currentMsg.message_id, null, {
                        type: photo ? 'photo' : 'video',
                        media: photo || video,
                        caption: text,
                        parse_mode: 'HTML'
                    }, { reply_markup });
                    await addMessageToTrack(userId, currentMsg.message_id);
                    return;
                } catch (e) { if (!e.description.includes('not modified')) throw e; }
            }
        }

        // 2. TENTATIVE DE DELETE OLD (Vortex)
        const oldMenuId = (currentMsg ? currentMsg.message_id : null) || (user ? user.last_menu_id : null);
        if (oldMenuId) {
            await ctx.telegram.deleteMessage(chatId, oldMenuId).catch(() => { });
        }

        // Supprimer aussi tous les messages traqués (pour être sûr qu'il n'en reste qu'un)
        if (user && user.tracked_messages && user.tracked_messages.length > 0) {
            for (const mid of user.tracked_messages) {
                if (mid !== oldMenuId) ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
            }
        }

        // 3. ENVOI DU NOUVEAU
        let newMsg;
        if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
        else if (video) newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
        else newMsg = await ctx.replyWithHTML(text, extra);

        if (newMsg) {
            await addMessageToTrack(userId, newMsg.message_id);
        }

    } catch (e) {
        console.error('❌ SafeEdit Error:', e.message);
        const fallback = await ctx.replyWithHTML(text, extra).catch(() => { });
        if (fallback) addMessageToTrack(userId, fallback.message_id);
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
