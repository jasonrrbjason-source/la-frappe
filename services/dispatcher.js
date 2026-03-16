const { registry } = require('../channels/ChannelRegistry');
const { registerUser, getAppSettings } = require('./database');
const { createPersistentMap } = require('./persistent_map');

class Dispatcher {
    constructor() {
        this.commands = new Map();
        this.actions = new Map();
        this.middleware = [];
        this.onHandlers = [];
        this.catchHandler = null;
        this.userLastButtons = createPersistentMap('userLastButtons'); // Persistance des boutons pour fallback numérique WA
        this.userLastMessageIds = createPersistentMap('userLastMessageIds'); // Persistance des IDs pour suppression
        this.userSessions = createPersistentMap('userSessions'); // Persistance des sessions (états de saisie)
    }

    async init() {
        await this.userLastButtons.load();
        await this.userLastMessageIds.load();
        await this.userSessions.load();
    }

    // Permet aux fonctions externes (notifyUser) d'enregistrer des boutons pour le fallback numérique WA
    setLastButtons(userId, buttons) {
        if (buttons && buttons.length > 0) {
            console.log(`[Dispatcher] setLastButtons for ${userId}: ${JSON.stringify(buttons.map(b => b.id || b.title))}`);
            this.userLastButtons.set(userId, buttons);
        }
    }

    // --- Interface pour simuler Telegraf ---
    use(fn) { this.middleware.push(fn); }
    command(cmd, fn) { this.commands.set(cmd, fn); }
    action(trigger, fn) { this.actions.set(trigger, fn); }
    on(type, fn) { this.onHandlers.push({ type, fn }); }
    catch(fn) { this.catchHandler = fn; }

    // --- Gestion des messages entrants ---
    async handleUpdate(channel, msg) {
        const fromStr = String(msg.from || '');
        console.log(`[Dispatcher] HandleUpdate from ${channel.type}: ${fromStr}`);
        
        // Auto-enregistrement/mise à jour de l'utilisateur pour ce canal
        try {
            // Pour WhatsApp, on garde le JID complet (indispensable pour LID vs PN)
            const userId = channel.type === 'whatsapp' ? fromStr : fromStr.split('@')[0];
            
            const { isNew, user: registeredUser } = await registerUser({
                id: userId,
                first_name: msg.name || 'Utilisateur WhatsApp',
                username: '',
                type: 'user'
            }, channel.type);
            
            msg.user = registeredUser;
        } catch (e) {
            console.error(`[Dispatcher] Auto-reg failed:`, e.message);
        }

        // Uniformisation du contexte
        const ctx = await this._createUnifiedContext(channel, msg);
        
        try {
            // 1. Exécuter les middlewares
            let index = -1;
            const next = async () => {
                index++;
                if (index < this.middleware.length) {
                    await this.middleware[index](ctx, next);
                } else {
                    await this._route(ctx);
                }
            };
            await next();
        } catch (err) {
            console.error(`[Dispatcher] Error:`, err);
            if (this.catchHandler) await this.catchHandler(err, ctx);
        }
    }

    async _createUnifiedContext(channel, msg) {
        const userId = msg.from;
        const settings = await getAppSettings();
        
        const ctx = {
            channel: channel,
            platform: channel.type, // 'telegram' ou 'whatsapp'
            from: { id: userId, first_name: msg.name, is_bot: false, username: msg.username },
            chat: { id: userId, type: 'private' },
            state: { settings: settings }, 
            session: this.userSessions.get(userId) || {},
            message: { text: msg.text },
            updateType: msg.type || 'message',
            match: null,
            botInfo: { username: settings.bot_name || 'Bot' },
            callbackQuery: msg.isAction ? { 
                data: msg.text,
                message: msg.ctx?.callbackQuery?.message || null
            } : null,
            telegram: {
                getFileLink: async (fileId) => {
                    if (typeof fileId === 'string' && (fileId.startsWith('http') || fileId.includes('firebasestorage') || fileId.includes('supabase'))) {
                        return { href: fileId };
                    }
                    if (channel.type === 'telegram') {
                        return channel.bot.telegram.getFileLink(fileId);
                    }
                    return null;
                },
                sendMessage: (chatId, text, opts) => channel.sendMessage(chatId, text, opts),
                sendPhoto: (chatId, photo, opts) => channel.replyWithPhoto(photo, opts),
            },
            
            // Handle WhatsApp Media Pre-upload
            _handleWAMedia: async () => {
                if (msg.isMedia && channel.type === 'whatsapp') {
                    const buffer = await channel.downloadMedia(msg.raw);
                    if (buffer) {
                        const { uploadMediaFromBuffer } = require('./database');
                        const m = msg.raw.message;
                        const contentType = m?.imageMessage ? 'image/jpeg' : (m?.videoMessage ? 'video/mp4' : 'application/octet-stream');
                        const ext = contentType.split('/')[1].split(';')[0] || 'bin';
                        const fileName = `wa_${Date.now()}.${ext}`;
                        try {
                            const publicUrl = await uploadMediaFromBuffer(buffer, fileName, contentType);
                            if (publicUrl) {
                                ctx.message.photo = [{ file_id: publicUrl }];
                                ctx.message.caption = msg.text;
                            }
                        } catch (e) {
                            console.error('[Dispatcher-WA-Media] Upload failed:', e.message);
                        }
                    }
                }
            },
            
            reply: async (text, extra = {}) => {
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                // Cleanup auto pour WA
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    console.log(`[WA-Cleanup] Tentative de suppression de ${oldIds.length} messages pour ${userId}`);
                    for(const id of oldIds) {
                        try {
                            await channel.deleteMessage(userId, id);
                        } catch (e) {
                            console.warn(`[WA-Cleanup] Echec suppression ${id}:`, e.message);
                        }
                    }
                    this.userLastMessageIds.delete(userId);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, text, options.buttons, options);
                } else {
                    res = await channel.sendMessage(userId, text, options);
                }
                
                if (channel.type === 'whatsapp') {
                    const sentIds = res.sentIds || (res.messageId ? [res.messageId] : []);
                    if (sentIds.length > 0) {
                        this.userLastMessageIds.set(userId, sentIds);
                        console.log(`[WA-Stored] IDs stockés pour ${userId}:`, sentIds);
                    }
                }
                return res;
            },
            replyWithHTML: async (text, extra = {}) => ctx.reply(text, { ...extra, parse_mode: 'HTML' }),
            replyWithPhoto: async (photo, extra = {}) => {
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: photo, media_type: 'photo' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: photo, media_type: 'photo' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                return res;
            },
            replyWithVideo: async (video, extra = {}) => {
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: video, media_type: 'video' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: video, media_type: 'video' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                return res;
            },
            answerCbQuery: async (text) => {
                console.log(`[CB-Answer] ${text || ''}`);
                // Utiliser le vrai answerCbQuery Telegraf si disponible
                if (msg.ctx?.answerCbQuery) {
                    return msg.ctx.answerCbQuery(text).catch(() => {});
                }
                return true;
            },
            deleteMessage: async (mid) => {
                if (channel.type === 'whatsapp') return channel.deleteMessage(userId, mid);
                if (channel.type === 'telegram') {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) return tgBot.telegram.deleteMessage(userId, mid).catch(() => {});
                }
                return true;
            },
            editMessageText: async (text, extra = {}) => {
                if (channel.type === 'telegram' && ctx.callbackQuery?.message) {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) {
                        try {
                            return await tgBot.telegram.editMessageText(userId, ctx.callbackQuery.message.message_id, null, text, { parse_mode: 'HTML', ...extra });
                        } catch (e) {
                            if (!String(e.description || '').includes('not modified')) console.warn('[Dispatcher] editMessageText failed:', e.message);
                        }
                    }
                }
                return ctx.reply(text, extra);
            },
            telegram: {
                sendMessage: async (id, text, extra = {}) => ctx.reply(text, extra),
                sendPhoto: async (id, photo, extra = {}) => ctx.replyWithPhoto(photo, extra),
                sendVideo: async (id, video, extra = {}) => ctx.replyWithVideo(video, extra),
                editMessageText: async (cid, mid, mid2, text, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageText(cid || userId, mid, mid2, text, { parse_mode: 'HTML', ...extra });
                    }
                    return ctx.reply(text, extra);
                },
                editMessageMedia: async (cid, mid, mid2, media, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageMedia(cid || userId, mid, mid2, media, extra);
                    }
                    return ctx.replyWithPhoto(media.media, { caption: media.caption });
                },
                deleteMessage: async (cid, mid) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.deleteMessage(cid || userId, mid).catch(() => {});
                    }
                    return channel.deleteMessage(cid || userId, mid);
                },
                setChatMenuButton: async () => {}
            }
        };

        await ctx._handleWAMedia();

        return ctx;
    }

    _convertExtra(extra) {
        const options = {};
        if (extra.reply_markup) {
            if (extra.reply_markup.inline_keyboard) {
                options.buttons = extra.reply_markup.inline_keyboard.flat().map(b => ({
                    id: b.callback_data,
                    title: b.text,
                    url: b.url
                }));
            }
        }
        if (extra.parse_mode === 'HTML') options.parse_mode = 'HTML';
        if (extra.photo) options.media_url = extra.photo;
        if (extra.caption) options.caption = extra.caption;
        return options;
    }

    async _route(ctx) {
        const text = ctx.message.text || '';
        const lowerText = text.toLowerCase().trim();
        console.log(`[Dispatcher] Incoming: "${text}" from ${ctx.from.id} (Action: ${!!ctx.callbackQuery})`);
        
        // 1. Gestion des CALLBACKS (Boutons Telegram & Actions WhatsApp)
        if (ctx.callbackQuery) {
            const data = ctx.callbackQuery.data;
            if (await this._routeAction(ctx, data)) {
                this.userSessions.set(ctx.from.id, ctx.session);
                return;
            }
        }

        // 2. Gestion des ETATS de session (ex: réponse libre sondage)
        if (ctx.session.awaiting_poll_free) {
            const broadcastId = ctx.session.awaiting_poll_free;
            const { recordPollFreeResponse } = require('./database');
            const res = await recordPollFreeResponse(broadcastId, text, ctx.from.id, ctx.from.username || ctx.from.first_name);
            
            if (res.error) {
                await ctx.reply(`❌ Erreur : ${res.error}`);
            } else {
                await ctx.reply("✅ Votre réponse a été enregistrée ! Merci.");
            }
            
            delete ctx.session.awaiting_poll_free;
            this.userSessions.set(ctx.from.id, ctx.session);
            return;
        }

        // 3. Commande explicite /cmd
        if (text.startsWith('/')) {
            const cmd = text.split(' ')[0].substring(1);
            if (this.commands.has(cmd)) {
                return await this.commands.get(cmd)(ctx);
            }
        }

        // 3. Fallback WhatsApp: "menu", "start", etc. ou CHIFFRE si menu fallback affiché
        if (['menu', 'hi', 'bonjour', 'start', 'boutique', 'catalogue'].includes(lowerText)) {
            if (this.commands.has('start')) return await this.commands.get('start')(ctx);
        }

        // Si le texte est un chiffre (ex: "2"), on regarde dans les DERNIERS BOUTONS envoyés
        if (ctx.channel.type === 'whatsapp' && /^\d+$/.test(lowerText)) {
            const index = parseInt(lowerText) - 1;
            const lastButtons = this.userLastButtons.get(ctx.from.id);
            console.log(`[Dispatcher] Chiffre "${lowerText}" reçu de ${ctx.from.id}, boutons stockés: ${lastButtons ? lastButtons.length : 'AUCUN'}`);
            
            if (lastButtons && lastButtons[index]) {
                const btn = lastButtons[index];
                const trigger = btn.id || btn.callback_data;
                console.log(`[Dispatcher] Numerical fallback: ${lowerText} -> ${trigger}`);
                if (trigger && await this._routeAction(ctx, trigger)) return;
            } else {
                // Si on reçoit un chiffre mais qu'on n'a pas de boutons en mémoire
                console.warn(`[Dispatcher] Chiffre reçu sans boutons correspondants pour ${ctx.from.id}`);
                await ctx.reply("⚠️ *Session expirée ou commande inconnue.*\n\nTapez *menu* pour afficher les options disponibles.");
                return;
            }
        }

        // 4. Handlers globaux (on text, message, etc.)
        for (const h of this.onHandlers) {
            if (h.type === 'text' && ctx.message.text) await h.fn(ctx, () => {});
            else if (h.type === 'message') await h.fn(ctx, () => {});
            else if (h.type === 'location' && ctx.message.location) await h.fn(ctx, () => {});
        }
    }

    async _routeAction(ctx, data) {
        for (const [trigger, fn] of this.actions.entries()) {
            if (typeof trigger === 'string' && data === trigger) {
                await fn(ctx);
                return true;
            } else if (trigger instanceof RegExp) {
                const match = data.match(trigger);
                if (match) {
                    ctx.match = match;
                    await fn(ctx);
                    return true;
                }
            }
        }
        return false;
    }
}

const dispatcher = new Dispatcher();
module.exports = { dispatcher };
