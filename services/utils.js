const { getLastMenuId, addMessageToTrack, getUser } = require('./database');

/**
 * L'Unique porte de sortie pour les menus du bot.
 * Garantit qu'un seul message de menu existe à la fois (Flux Constant).
 */
function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeEdit(ctx, text, opts = {}) {
    const isGroup = ctx.chat.type !== 'private';
    const userId = isGroup ? `telegram_${ctx.chat.id}` : `telegram_${ctx.from.id}`;
    const chatId = ctx.chat.id;

    // 1. Médias & Clavier
    let photo = opts.photo || null;
    const video = opts.video || null;
    if (photo === '') photo = null;

    // 2. Résolution Photo (Base URL si path relatif + Extraction Liste)
    if (photo && typeof photo === 'string') {
        const settings = ctx.state?.settings || {};
        const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');

        // Extraction si c'est une liste (JSON ou CSV)
        if (photo.startsWith('[') && photo.endsWith(']')) {
            try {
                const arr = JSON.parse(photo);
                if (arr.length > 0) photo = typeof arr[0] === 'string' ? arr[0] : (arr[0].url || arr[0].path || '');
            } catch (e) { }
        } else if (photo.includes(',') && !photo.startsWith('http')) {
            photo = photo.split(',')[0].trim();
        }

        // Si c'est un chemin relatif, on ajoute le baseUrl
        if (photo && !photo.startsWith('http') && !photo.startsWith('data:')) {
            photo = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
        }
    }

    let reply_markup = opts.reply_markup || (opts.inline_keyboard ? opts : (Array.isArray(opts) ? { inline_keyboard: opts } : null));
    // Support Telegraf Markup
    if (reply_markup && reply_markup.reply_markup) reply_markup = reply_markup.reply_markup;
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    try {
        const currentMsg = ctx.callbackQuery?.message;
        const user = await getUser(userId).catch(() => null);

        // A. TENTATIVE D'EDIT SI TYPE IDENTIQUE
        if (currentMsg) {
            const isMediaMsg = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            if (isMediaMsg === wantMedia) {
                try {
                    if (!wantMedia) {
                        await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    } else {
                        await ctx.telegram.editMessageMedia(chatId, currentMsg.message_id, null, {
                            type: photo ? 'photo' : 'video',
                            media: photo || video,
                            caption: text,
                            parse_mode: 'HTML'
                        }, { reply_markup });
                    }
                    await addMessageToTrack(userId, currentMsg.message_id).catch(() => { });
                    return;
                } catch (e) {
                    if (!String(e.description || '').includes('not modified')) {
                        // Si l'edit échoue vraiment (ex: message supprimé entre temps), on continue en "Send"
                        console.warn('safeEdit: edit failed, falling back to send', e.message);
                    } else return;
                }
            }
        }

        // B. ENVOI DU NOUVEAU MENU
        let newMsg;
        if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
        else if (video) newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
        else newMsg = await ctx.replyWithHTML(text, extra);

        if (newMsg) {
            await addMessageToTrack(userId, newMsg.message_id).catch(() => { });
        }

        // C. NETTOYAGE APRÈS (Uniquement si le nouveau est visible)
        const toDelete = new Set();
        if (currentMsg) toDelete.add(currentMsg.message_id);
        if (user && user.last_menu_id) toDelete.add(user.last_menu_id);
        if (user && user.tracked_messages) {
            user.tracked_messages.forEach(mid => { if (mid && (!newMsg || String(mid) !== String(newMsg.message_id))) toDelete.add(mid); });
        }

        for (const mid of toDelete) {
            if (!newMsg || String(mid) !== String(newMsg.message_id)) {
                await ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
            }
        }

    } catch (e) {
        console.error('❌ safeEdit Fatal:', e.message);
        // Fallback d'urgence
        try {
            const fb = await ctx.replyWithHTML(text, extra);
            if (fb) addMessageToTrack(userId, fb.message_id).catch(() => { });
        } catch (err) { }
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

module.exports = { safeEdit, debugLog, esc };
