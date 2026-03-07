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

    // 2. Résolution Photo (Base URL si path relatif + Extraction Liste)
    if (photo) {
        const settings = ctx.state?.settings || {};
        const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');

        if (Array.isArray(photo)) {
            if (photo.length > 0) {
                const first = photo[0];
                photo = typeof first === 'string' ? first : (first.url || first.path || '');
            } else {
                photo = null;
            }
        }

        if (typeof photo === 'string') {
            const clean = photo.trim();
            if (clean.startsWith('[') && clean.endsWith(']')) {
                try {
                    const arr = JSON.parse(clean);
                    if (arr && arr.length > 0) {
                        const first = arr[0];
                        photo = typeof first === 'string' ? first : (first.url || first.path || '');
                    } else {
                        photo = null;
                    }
                } catch (e) {
                    photo = clean.replace(/[\[\]"']/g, '').split(',')[0].trim();
                }
            } else if (clean.includes(',') && !clean.startsWith('http')) {
                photo = clean.split(',')[0].trim();
            } else {
                photo = clean;
            }
        }

        // Final check: if relative, add baseUrl
        if (photo && typeof photo === 'string' && !photo.startsWith('http') && !photo.startsWith('data:')) {
            photo = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
        }
    }

    let reply_markup = opts.reply_markup || (opts.inline_keyboard ? opts : (Array.isArray(opts) ? { inline_keyboard: opts } : null));
    // Support Telegraf Markup
    if (reply_markup && reply_markup.reply_markup) reply_markup = reply_markup.reply_markup;
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    const currentMsg = ctx.callbackQuery?.message;
    const user = await getUser(userId).catch(() => null);

    const cleanupOldMessages = async (newId) => {
        try {
            const userObj = await getUser(userId).catch(() => null);
            const toDelete = new Set();
            if (currentMsg) toDelete.add(String(currentMsg.message_id));
            if (userObj && userObj.last_menu_id) toDelete.add(String(userObj.last_menu_id));
            if (userObj && userObj.tracked_messages) {
                userObj.tracked_messages.forEach(mid => { if (mid) toDelete.add(String(mid)); });
            }

            if (newId) toDelete.delete(String(newId));

            for (const mid of toDelete) {
                await ctx.telegram.deleteMessage(chatId, parseInt(mid)).catch(() => { });
            }
        } catch (e) {
            console.error('safeEdit Cleanup Error:', e.message);
        }
    };

    try {
        // A. TENTATIVE D'EDIT SI TYPE IDENTIQUE
        if (currentMsg) {
            const isMediaMsg = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            if (isMediaMsg === wantMedia) {
                try {
                    if (!wantMedia) {
                        await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    } else {
                        await ctx.telegram.editMessageMedia(chatId, currentMsg.message_id, {
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
                        console.warn('safeEdit: edit failed, fallback to send', e.message);
                    } else return;
                }
            }
        }

        // B. ENVOI DU NOUVEAU MENU
        let newMsg;
        if (photo) {
            try {
                newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
            } catch (err) {
                console.error('safeEdit: replyWithPhoto error', err.message);
                newMsg = await ctx.replyWithHTML(text, extra);
            }
        } else if (video) {
            try {
                newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
            } catch (err) {
                console.error('safeEdit: replyWithVideo error', err.message);
                newMsg = await ctx.replyWithHTML(text, extra);
            }
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
