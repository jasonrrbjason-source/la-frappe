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
        const cleanPhoto = photo.trim();
        if (cleanPhoto.startsWith('[') && cleanPhoto.endsWith(']')) {
            try {
                const arr = JSON.parse(cleanPhoto);
                if (arr && arr.length > 0) {
                    const first = typeof arr[0] === 'string' ? arr[0] : (arr[0].url || arr[0].path || '');
                    photo = first;
                }
            } catch (e) {
                // Fallback basic si JSON malformé mais contient des crochets
                photo = cleanPhoto.replace(/[\[\]"']/g, '').split(',')[0].trim();
            }
        } else if (cleanPhoto.includes(',') && !cleanPhoto.startsWith('http')) {
            photo = cleanPhoto.split(',')[0].trim();
        } else {
            photo = cleanPhoto;
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

    const cleanupOldMessages = async (newId) => {
        try {
            const currentMsg = ctx.callbackQuery?.message; // Need to re-declare or pass it
            const user = await getUser(userId).catch(() => null); // Need to re-fetch or pass it

            const toDelete = new Set();
            if (currentMsg) toDelete.add(String(currentMsg.message_id));
            if (user && user.last_menu_id) toDelete.add(String(user.last_menu_id));
            if (user && user.tracked_messages) {
                user.tracked_messages.forEach(mid => { if (mid) toDelete.add(String(mid)); });
            }

            // Ne jamais supprimer le nouveau message qu'on vient d'envoyer
            if (newId) toDelete.delete(String(newId));

            for (const mid of toDelete) {
                await ctx.telegram.deleteMessage(chatId, parseInt(mid)).catch(() => { });
            }
        } catch (e) {
            console.error('safeEdit: cleanup error', e.message);
        }
    };

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
                        console.warn('safeEdit: edit failed, falling back to send', e.message);
                    } else return;
                }
            }
        }

        // B. ENVOI DU NOUVEAU MENU
        let newMsg;
        if (photo) {
            newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra }).catch(async (err) => {
                console.error('safeEdit: replyWithPhoto failed', err.message);
                return await ctx.replyWithHTML(text, extra); // Fallback immédiat si photo invalide
            });
        } else if (video) {
            newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra }).catch(async (err) => {
                console.error('safeEdit: replyWithVideo failed', err.message);
                return await ctx.replyWithHTML(text, extra);
            });
        } else {
            newMsg = await ctx.replyWithHTML(text, extra);
        }

        if (newMsg) {
            await addMessageToTrack(userId, newMsg.message_id).catch(() => { });
            // C. NETTOYAGE APRÈS ENVOI RÉUSSI
            await cleanupOldMessages(newMsg.message_id);
        }

    } catch (e) {
        console.error('❌ safeEdit Fatal:', e.message);
        try {
            const fb = await ctx.replyWithHTML(text, extra);
            if (fb) {
                await addMessageToTrack(userId, fb.message_id).catch(() => { });
                await cleanupOldMessages(fb.message_id);
            }
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
