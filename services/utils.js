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

    // Normalisation Photo (Base URL si path relatif)
    if (photo && typeof photo === 'string' && !photo.startsWith('http') && !photo.startsWith('data:')) {
        const settings = ctx.state?.settings || {};
        const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');
        if (photo.startsWith('[') && photo.endsWith(']')) {
            try {
                const arr = JSON.parse(photo);
                if (arr.length > 0) {
                    const first = typeof arr[0] === 'string' ? arr[0] : (arr[0].url || arr[0].path || '');
                    photo = first.startsWith('http') ? first : baseUrl + (first.startsWith('/') ? '' : '/') + first;
                }
            } catch (e) { }
        } else {
            photo = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
        }
    }

    let reply_markup = opts.reply_markup || (opts.inline_keyboard ? opts : (Array.isArray(opts) ? { inline_keyboard: opts } : null));
    // Support Telegraf Markup
    if (reply_markup && reply_markup.reply_markup) reply_markup = reply_markup.reply_markup;
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    try {
        const currentMsg = ctx.callbackQuery?.message;
        const user = await getUser(userId);

        // A. TENTATIVE D'EDIT (Dynamic) - Le plus propre si possible
        if (currentMsg) {
            const hasMedia = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            if (!hasMedia && !wantMedia) {
                try {
                    await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    await addMessageToTrack(userId, currentMsg.message_id);
                    return;
                } catch (e) { if (!String(e.description || '').includes('not modified')) throw e; return; }
            }

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
                } catch (e) { if (!String(e.description || '').includes('not modified')) throw e; return; }
            }
        }

        // B. NETTOYAGE AGGRESSIF (Suppression directe de TOUT ce qui précède)
        const toDelete = new Set();
        if (currentMsg) toDelete.add(currentMsg.message_id);
        if (user && user.last_menu_id) toDelete.add(user.last_menu_id);
        if (user && user.tracked_messages) {
            user.tracked_messages.forEach(mid => { if (mid) toDelete.add(mid); });
        }

        for (const mid of toDelete) {
            await ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
        }

        // C. ENVOI DU NOUVEAU
        let newMsg;
        if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
        else if (video) newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
        else newMsg = await ctx.replyWithHTML(text, extra);

        if (newMsg) {
            await addMessageToTrack(userId, newMsg.message_id);
        }

    } catch (e) {
        console.error('❌ safeEdit Error:', e.message);
        const fb = await ctx.replyWithHTML(text, extra).catch(() => { });
        if (fb) addMessageToTrack(userId, fb.message_id);
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
