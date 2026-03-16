require('dotenv').config({ path: process.env.RAILWAY_ENVIRONMENT ? '.env.railway' : '.env' });
const { validateLicense } = require('./services/license');
if (!validateLicense()) {
    console.error('❌ Licence invalide ou manquante. Arrêt.');
    process.exit(1);
}

const { createServer, setBotInstance } = require('./server');
const { dispatcher } = require('./services/dispatcher');
const { registry } = require('./channels/ChannelRegistry');
const { initChannels } = require('./services/channel_init');

// Handlers
const { setupStartHandler, initStartState } = require('./handlers/start');
const { setupAdminHandlers } = require('./handlers/admin');
const { setupOrderSystem, initOrderState } = require('./handlers/order_system');
const { setBroadcastBot } = require('./services/broadcast');

const PORT = process.env.PORT || 3000;

async function main() {
    console.log('🚀 Démarrage du Bot Multi-Canaux (Telegram & WhatsApp)...\n');

    // 1. Liaison des Handlers au Dispatcher (Mocking Telegraf)
    // Cela permet de réutiliser 100% de la logique existante
    setupStartHandler(dispatcher);
    setupAdminHandlers(dispatcher);
    setupOrderSystem(dispatcher);
    const { broadcastMessage } = require('./services/broadcast');
    const { recordPollVote, recordPollFreeResponse } = require('./services/database');

    // Gestion des votes de sondage
    dispatcher.action(/^poll_vote_([\w-]+)_(\d+)(?:_(\d+))?$/, async (ctx) => {
        const broadcastId = ctx.match[1];
        const optionIndex = parseInt(ctx.match[2]);
        const res = await recordPollVote(broadcastId, optionIndex, ctx.from.id, ctx.from.username || ctx.from.first_name);
        
        if (res.error) {
            return ctx.answerCbQuery(`❌ ${res.error}`, { show_alert: true });
        }
        await ctx.answerCbQuery("✅ Vote enregistré !");
    });

    // Gestion des réponses libres de sondage
    dispatcher.action(/^poll_free_([\w-]+)(?:_(\d+))?$/, async (ctx) => {
        const broadcastId = ctx.match[1];
        ctx.session.awaiting_poll_free = broadcastId;
        await ctx.answerCbQuery();
        await ctx.reply("✍️ Veuillez envoyer votre réponse par message :");
    });

    dispatcher.command('test_broadcast', async (ctx) => {
        if (ctx.from.id !== 'admin') { /* On pourrait filtrer mais c'est pour le test */ }
        console.log('📣 Test de diffusion déclenché par commande');
        await ctx.reply('🚀 Lancement de la diffusion de test...');
        const res = await broadcastMessage('users', '🚀 <b>DIFFUSION TEST MULTI-CANAUX</b>\n\nSi vous recevez ce message, le système de diffusion fonctionne sur Telegram et WhatsApp ! ✅');
        await ctx.reply(`📊 Résultat : ${res.success} succès, ${res.failed} échecs.`);
    });

    // 2. Initialisation des Canaux
    await initChannels();

    // 3. Liaison des Canaux au Dispatcher
    const channels = registry.query();
    for (const channel of channels) {
        channel.onMessage(async (msg) => {
            await dispatcher.handleUpdate(channel, msg);
        });
        
        // Si c'est Telegram, on garde une référence pour les services qui en ont besoin
        if (channel.type === 'telegram') {
            const bot = channel.getBotInstance ? channel.getBotInstance() : null;
            if (bot) {
                setBotInstance(bot);
                setBroadcastBot(bot);
            }
        }
    }

    // 4. Démarrage du Serveur Web (Dashboard Admin & Webhooks)
    const serverStarted = new Promise((resolve) => {
        try {
            const server = createServer();
            
            // Route Webhook WhatsApp (si besoin pour Official API)
            server.post('/webhook/whatsapp', async (req, res) => {
                const waChannel = registry.query('whatsapp');
                if (waChannel && waChannel.handleWebhook) {
                    await waChannel.handleWebhook(req.body);
                }
                res.sendStatus(200);
            });
            
            server.get('/webhook/whatsapp', (req, res) => {
                const waChannel = registry.query('whatsapp');
                if (waChannel && waChannel.verifyWebhook) {
                    const result = waChannel.verifyWebhook(
                        req.query['hub.mode'],
                        req.query['hub.verify_token'],
                        req.query['hub.challenge']
                    );
                    if (result) return res.send(result);
                }
                res.sendStatus(403);
            });

            server.listen(PORT, '0.0.0.0', () => {
                console.log(`🌐 Dashboard Admin : http://localhost:${PORT}/dashboard`);
                resolve();
            });
        } catch (err) {
            console.error('❌ Impossible de lancer le serveur web:', err.message);
            resolve();
        }
    });

    // 5. Restauration de l'état persistant
    await Promise.all([
        initOrderState(), 
        initStartState(), 
        require('./handlers/admin').initAdminState(),
        dispatcher.init()
    ]);

    await serverStarted;

    console.log('\n🚀 Environnement prêt !');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Graceful shutdown
    const stop = async () => {
        console.log('\n🛑 Arrêt des services...');
        await registry.stopAll();
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

// Process-level error handlers
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled Rejection:', err.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message || err);
});

main().catch((error) => {
    console.error('❌ Erreur fatale au démarrage:', error);
    process.exit(1);
});
