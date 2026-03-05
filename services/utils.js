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
    delete opts.photo;
    delete opts.video;

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
        // --- TENTATIVE 1 : EDIT (Si bouton cliqué et pas de média impliqué) ---
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            const currentMsg = ctx.callbackQuery.message;
            const hasMediaInChat = !!(currentMsg.photo || currentMsg.video || currentMsg.animation);

            // On ne peut érafer (edit) que si on n'a pas de média (actuel ou futur)
            if (!hasMediaInChat && !photo && !video) {
                try {
                    await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    // On met à jour le tracking au cas où
                    await addMessageToTrack(trackId, currentMsg.message_id).catch(() => { });
                    return; // Succès ! Interface constante préservée.
                } catch (err) {
                    // Si l'erreur est "message is not modified", on s'arrête là (déjà affiché)
                    if (err.description && err.description.includes('message is not modified')) return;
                    // Sinon, on tombe dans le fallback (delete & resend)
                }
            }
        }

        // --- TENTATIVE 2 : DELETE & RESEND (Nettoyage agressif) ---

        // 1. Supprimer le message associé au clic (si existe)
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => { });
        }

        // 2. Supprimer TOUS les anciens menus connus du bot pour cet utilisateur
        const user = await getUser(trackId);
        if (user) {
            // Nettoyage du dernier menu connu
            if (user.last_menu_id) {
                await ctx.telegram.deleteMessage(chatId, user.last_menu_id).catch(() => { });
            }
            // Nettoyage de la pile des messages traqués (6h)
            if (user.tracked_messages && user.tracked_messages.length > 0) {
                // On n'en supprime que quelques uns pour éviter de bloquer sur les limites API
                const toClean = user.tracked_messages.slice(-5);
                for (const mid of toClean) {
                    if (mid !== (ctx.callbackQuery?.message?.message_id)) {
                        await ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
                    }
                }
            }
        }

        // 3. Envoi du nouveau menu
        let newMsg;
        if (photo) {
            newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
        } else if (video) {
            newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
        } else {
            newMsg = await ctx.replyWithHTML(text, extra);
        }

        // 4. Enregistrement du nouveau menu unique
        if (newMsg && newMsg.message_id) {
            await addMessageToTrack(trackId, newMsg.message_id).catch(() => { });
        }

    } catch (e) {
        console.error('❌ SafeEdit CRITICAL error:', e.message);
        // Fallback ultime : on envoie quand même le message
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
