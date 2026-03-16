const Baileys = require('@whiskeysockets/baileys');
const makeWASocket = Baileys.default || Baileys;
const { useMultiFileAuthState, DisconnectReason, jidDecode, fetchLatestBaileysVersion } = Baileys;


const { Channel } = require('./Channel');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');



class WhatsAppSessionChannel extends Channel {
    constructor(config) {
        super('whatsapp', 'WhatsApp (Session)');
        this.sessionId = config.sessionId || 'default';
        this.authFolder = path.join(process.cwd(), 'sessions', this.sessionId);
        this.sock = null;
        this.messageHandler = null;
        // Comment out store if not found
        this.store = null; 
    }

    async initialize() {
        if (!fs.existsSync(path.join(process.cwd(), 'sessions'))) {
            fs.mkdirSync(path.join(process.cwd(), 'sessions'));
        }
        console.log(`[WA-Session] Initializing session: ${this.sessionId}`);
    }

    async start() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using version v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), // Silent to see my logs
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        // --- METHODE PAIRING CODE (SANS SCANNER) ---
        const pairingNumber = process.env.WHATSAPP_PAIRING_NUMBER;
        if (pairingNumber && !this.sock.authState.creds.registered) {
            console.log(`\n[WA] 🔑 Demande de code d'appairage pour : ${pairingNumber}...`);
            setTimeout(async () => {
                try {
                    const code = await this.sock.requestPairingCode(pairingNumber.replace(/\D/g, ''));
                    console.log('--------------------------------------------------');
                    console.log(`👉 TON CODE WHATSAPP : ${code.toUpperCase()}`);
                    console.log('Saisis ce code sur ton téléphone (Lier un appareil > Lier avec le numéro)');
                    console.log('--------------------------------------------------\n');
                } catch (err) {
                    console.error('❌ Erreur demande Pairing Code:', err.message);
                }
            }, 3000); // Petit délai pour laisser le socket se stabiliser
        }


        // this.store.bind(this.sock.ev); // Removed store bind

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log('[WA] Connection Update:', { connection, hasQr: !!qr });
            
            if (qr) {
                console.log('--------------------------------------------------');
                console.log('👉 SCANNEZ CE QR CODE POUR CONNECTER WHATSAPP :');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('--------------------------------------------------');
                
                // Sauvegarder en image pour l'utilisateur
                try {
                    const artifactPath = '/Users/dikenson/.gemini/antigravity/brain/03919c3c-ad09-4e7a-b379-dc801af3cdf7/whatsapp_qr.png';
                    await qrcodeImage.toFile(artifactPath, qr, {
                        color: { dark: '#000000', light: '#ffffff' },
                        width: 512
                    });
                    console.log(`✅ QR Image générée: ${artifactPath}`);
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err);
                }
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                console.log('[WA] Connexion fermée. Erreur:', error);
                const shouldReconnect = error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('[WA] Reconnexion tentative:', shouldReconnect);
                if (shouldReconnect) this.start();
            } else if (connection === 'open') {
                console.log('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
            }
        });


        this.sock.ev.on('messages.upsert', async (m) => {
            console.log(`[WA-Debug] Event messages.upsert type=${m.type}, count=${m.messages?.length}`);
            if (m.type !== 'notify') return;
            const selfJid = this.sock.user?.id;

            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;
                
                // Ignorer les messages de protocole sans contenu utile
                if (!msg.message || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

                const selfJidClean = selfJid?.split(':')[0];
                const remoteJidClean = remoteJid?.split('@')[0].split(':')[0];
                const isMessageToSelf = remoteJidClean === selfJidClean || remoteJid?.endsWith('@lid');
                
                // Détecter si le message vient d'un BOT (Baileys ou autre bot instance)
                const isBotId = msg.key.id.startsWith('BAE5') || msg.key.id.startsWith('3EB0') || msg.key.id.length > 20;
                
                console.log(`[WA-Debug] MSG: fromMe=${isMe}, isBotId=${isBotId}, remoteJid=${remoteJid}, toSelf=${isMessageToSelf}`);

                // Empêcher les boucles : on ignore tout ce qui est marqué fromMe SAUF si c'est nous qui écrivons manuellement (pas un ID de bot)
                if (isMe && isBotId) continue;
                // Si c'est un message "To Self" (notre propre compte), on accepte seulement si c'est un message manuel (pas du bot)
                if (isMe && !isBotId && isMessageToSelf) {
                    // C'est l'utilisateur humain qui écrit à son propre bot, on continue
                } else if (isMe) {
                    // C'est un message envoyé par le bot vers quelqu'un d'autre ou par nous manuellement vers quelqu'un d'autre
                    continue; 
                }

                const name = msg.pushName || 'User';
                const text = this._extractText(msg);
                const isAction = !!(msg.message?.listResponseMessage || msg.message?.buttonsResponseMessage);

                const isMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage);

                if (this.messageHandler && (text || isMedia)) {
                    console.log(`[WA-In] Text: "${text}" | Action: ${isAction} | Media: ${isMedia} | From: ${remoteJid}`);
                    await this.messageHandler({
                        from: remoteJid,
                        name: name,
                        text: text,
                        type: isMedia ? 'media' : 'text',
                        isAction: isAction,
                        isMedia: isMedia,
                        raw: msg
                    });
                }
            }
        });




    }

    async stop() {
        if (this.sock) this.sock.end();
        this.isActive = false;
    }

    onMessage(handler) { this.messageHandler = handler; }

    async downloadMedia(msg) {
        try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { 
                    logger: pino({ level: 'silent' }),
                    reauthoriseNetworkRequest: (m) => this.sock?.updateMediaMessage(m)
                }
            );
            return buffer;
        } catch (e) {
            console.error('[WA-Download] Error:', e.message);
            return null;
        }
    }

    async sendMessage(userId, text, options = {}) {
        if (!this.sock || !this.isActive) return { success: false, error: 'Not connected' };
        
        // Sécurité JID: on s'assure que l'ID a le bon suffixe si c'est un pur numéro
        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const cleanText = this._stripHTML(text);
        
        try {
            let result;
            if (options.media_url) {
                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                result = await this.sock.sendMessage(jid, {
                    [mediaType]: { url: options.media_url },
                    caption: cleanText
                });
            } else {
                result = await this.sock.sendMessage(jid, { text: cleanText });
            }
            return { success: true, messageId: result?.key?.id };
        } catch (e) {
            console.error('[WA-Send] Error:', e);
            return { success: false, error: e.message };
        }
    }

    async deleteMessage(jid, messageId) {
        if (!this.sock || !this.isActive || !messageId) return;
        try {
            await this.sock.sendMessage(jid, { 
                delete: { 
                    remoteJid: jid, 
                    fromMe: true, 
                    id: messageId, 
                    participant: undefined 
                } 
            });
            return true;
        } catch (e) {
            console.error('[WA-Delete] Error:', e);
            return false;
        }
    }

    async sendInteractive(userId, text, buttons = [], options = {}) {
        if (!this.sock || !this.isActive) return;
        
        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const cleanText = this._stripHTML(text);

        try {
            const sentIds = [];
            
            // Si on a un média, on l'envoie d'abord séparement car Baileys ne permet pas MEDIA + LIST
            if (options.media_url) {
                // On envoie le média avec le texte original comme légende
                const resMedia = await this.sendMessage(jid, text, options);
                if (resMedia.messageId) sentIds.push(resMedia.messageId);
                // Pour la liste qui suit, on utilise un texte générique court pour éviter la pollution
                text = "🔽 Cliquez ci-dessous pour les options :";
            }

            if (buttons.length > 0) {
                // Remplacement de l'émoji ◀️ par ⬅️ car il pose parfois problème d'affichage (rendu comme 'n' sur certains terminaux)
                const rows = buttons.map(b => ({
                    title: (b.title || '').replace('◀️', '⬅️'), 
                    rowId: b.id, 
                    description: "" 
                }));
                const listMessage = {
                    text: this._stripHTML(text),
                    footer: options.footer || "Sélectionnez une option",
                    title: options.title || "Menu",
                    buttonText: "Ouvrir le Menu ☰",
                    sections: [{ title: "Options", rows }]
                };

                try {
                    console.log(`[WA-Menu] Sending list to ${jid} with ${rows.length} rows`);
                    const resList = await this.sock.sendMessage(jid, listMessage);
                    if (resList?.key?.id) sentIds.push(resList.key.id);
                } catch (err) {
                    console.error('[WA-Menu] List send error:', err.message);
                    // Fallback TEXTUEL uniquement en cas d'erreur de la liste
                    try {
                        let textMenu = "\n*📋 MENU DIRECT :*\n";
                        buttons.forEach((b, i) => { textMenu += `*${i+1}* ${b.title}\n`; });
                        textMenu += "\n_Répondez avec le chiffre._";
                        const resFB = await this.sock.sendMessage(jid, { text: textMenu });
                        if (resFB?.key?.id) sentIds.push(resFB.key.id);
                    } catch (err2) {
                        console.error('[WA-Menu] Fallback send error:', err2.message);
                    }
                }

            } else {
                const res = await this.sendMessage(jid, text, options);
                if (res.messageId) sentIds.push(res.messageId);
            }
            return { success: true, sentIds };
        } catch (e) {
            console.error('[WA-Interactive] Multi-send failed:', e);
            const res = await this.sendMessage(jid, text, options);
            return { success: !!res.success, sentIds: res.messageId ? [res.messageId] : [] };
        }
    }

    _extractText(msg) {
        const m = msg.message;
        const text = m?.listResponseMessage?.singleSelectReply?.selectedRowId || 
                     m?.buttonsResponseMessage?.selectedButtonId || 
                     m?.conversation || 
                     m?.extendedTextMessage?.text || 
                     m?.imageMessage?.caption ||
                     m?.videoMessage?.caption ||
                     m?.documentMessage?.caption ||
                     "";
        return text;
    }

    _stripHTML(text) {
        return (text || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    }
}

module.exports = { WhatsAppSessionChannel };
