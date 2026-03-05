const express = require('express');
const cors = require('cors');
const path = require('path');
const fileUpload = require('express-fileupload');
const {
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers,
    getReferralLeaderboard, getStatsOverview, getDailyStats,
    getProducts, saveProduct, deleteProduct,
    getAllOrders, updateOrderStatus, setLivreurStatus, getOrder,
    setLivreurAvailability, getAppSettings, updateAppSettings,
    deleteUser, incrementOrderCount, makeDocId, getOrderAnalytics,
    db, admin, nukeDatabase
} = require('./services/database');
const { broadcastMessage } = require('./services/broadcast');
const fs = require('fs');

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_la_frappe.log'), line);
    } catch (e) { }
    console.log(msg);
}

require('dotenv').config();

// Référence partagée au bot Telegram (définie par index.js)
let _bot = null;
function setBotInstance(bot) { _bot = bot; }
function getBotInstance() { return _bot; }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function createServer() {
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(fileUpload({
        limits: { fileSize: 50 * 1024 * 1024 },
        useTempFiles: true,
        tempFileDir: '/tmp/'
    }));
    app.use('/public', express.static(path.join(__dirname, 'web', 'public')));

    // ========== Authentication ==========

    async function authMiddleware(req, res, next) {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
        if (!token) return res.status(401).json({ error: 'Token manquant' });

        const settings = await getAppSettings();
        if (token === settings.admin_password) {
            return next();
        }

        console.warn(`[AUTH] Tentative d'accès non autorisée avec le token: ${token.substring(0, 3)}...`);
        res.status(401).json({ error: 'Non autorisé' });
    }

    // ========== Static Pages ==========

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'login.html')));
    app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'dashboard.html')));
    app.get('/address-picker', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'address_picker.html')));


    // ========== API Routes ==========

    app.post('/api/login', async (req, res) => {
        try {
            const { password } = req.body;
            let settings = {};
            try {
                settings = await getAppSettings();
            } catch (e) {
                console.error('⚠️ getAppSettings() a échoué, fallback sur ADMIN_PASSWORD:', e.message);
            }

            if (password === settings.admin_password || password === ADMIN_PASSWORD) {
                res.json({ success: true, token: password });
            } else {
                res.status(401).json({ error: 'Mot de passe incorrect' });
            }
        } catch (e) {
            console.error('❌ Erreur login:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.get('/api/stats', authMiddleware, async (req, res) => {
        try { res.json(await getStatsOverview()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/stats/daily', authMiddleware, async (req, res) => {
        try { res.json(await getDailyStats(parseInt(req.query.days) || 30)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users', authMiddleware, async (req, res) => {
        try { res.json(await getRecentUsers(parseInt(req.query.limit) || 50)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users/search', authMiddleware, async (req, res) => {
        try { res.json(await searchUsers(req.query.q)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/delete', authMiddleware, async (req, res) => {
        try {
            await deleteUser(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/order', authMiddleware, async (req, res) => {
        try {
            await incrementOrderCount(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Product Routes ==========

    app.get('/api/products', authMiddleware, async (req, res) => {
        try { res.json(await getProducts()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/products', authMiddleware, async (req, res) => {
        try {
            const id = await saveProduct(req.body);
            res.json({ success: true, id });
        } catch (e) {
            console.error('Product save error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/products/:id', authMiddleware, async (req, res) => {
        try {
            await deleteProduct(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Order Routes ==========

    app.get('/api/orders', authMiddleware, async (req, res) => {
        try { res.json(await getAllOrders(parseInt(req.query.limit) || 100)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/analytics', authMiddleware, async (req, res) => {
        try { res.json(await getOrderAnalytics()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Upload Routes ==========
    app.post('/api/upload', authMiddleware, async (req, res) => {
        try {
            if (!req.files || !req.files.file) {
                return res.status(400).json({ error: 'Aucun fichier téléchargé' });
            }

            const file = req.files.file;
            const ext = path.extname(file.name) || (file.mimetype.includes('video') ? '.mp4' : '.jpg');
            const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;

            // 1. Sauvegarde locale (temporaire/fallback)
            const dir = path.resolve(__dirname, 'web', 'public', 'uploads');
            const uploadPath = path.join(dir, fileName);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            await file.mv(uploadPath);

            let finalUrl = `/public/uploads/${fileName}`;

            // 2. Tentative d'upload sur Supabase Storage (Persistance Cloud)
            try {
                const { supabase } = require('./config/supabase');

                debugLog(`[UPLOAD] Tentative Supabase Storage: ${fileName}`);

                // Read the file data from disk since 'useTempFiles' strips the buffer in req.files
                const fs = require('fs');
                const fileBuf = fs.readFileSync(uploadPath);

                const { data, error } = await supabase.storage
                    .from('uploads')
                    .upload(fileName, fileBuf, {
                        contentType: file.mimetype,
                        upsert: true
                    });

                if (error) {
                    throw error;
                }

                // URL publique standard Supabase Storage
                const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(fileName);
                finalUrl = publicData.publicUrl;

                debugLog(`[UPLOAD-OK] Supabase: ${finalUrl}`);
            } catch (storageErr) {
                debugLog(`[UPLOAD-WARN] Échec Supabase Storage: ${storageErr.message}. Utilisation fallback local.`);
            }

            res.json({ success: true, url: finalUrl });
        } catch (e) {
            debugLog(`[UPLOAD-FATAL] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/debug/dir', authMiddleware, async (req, res) => {
        try {
            const dir = path.resolve(__dirname, 'web', 'public', 'uploads');
            if (!fs.existsSync(dir)) return res.send('Répertoire inexistant.');
            const files = fs.readdirSync(dir);
            res.json({ dir, files });
        } catch (e) { res.status(500).send(e.message); }
    });

    app.get('/api/debug/logs', authMiddleware, async (req, res) => {
        try {
            const logPath = path.join(process.cwd(), 'debug_la_frappe.log');
            if (!fs.existsSync(logPath)) return res.send('Aucun log trouvé.');
            const content = fs.readFileSync(logPath, 'utf8');
            res.header('Content-Type', 'text/plain');
            res.send(content);
        } catch (e) { res.status(500).send(e.message); }
    });

    app.post('/api/livreurs/status', authMiddleware, async (req, res) => {
        const { userId, platform, isLivreur } = req.body;
        try {
            await setLivreurStatus(userId, platform, isLivreur);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/livreurs/availability', authMiddleware, async (req, res) => {
        const { userId, platform, isAvailable } = req.body;
        try {
            await setLivreurAvailability(makeDocId(platform, userId), isAvailable);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/admin/nuke', authMiddleware, async (req, res) => {
        try {
            debugLog(`[ADMIN] NUKE DATABASE REQUESTED BY ${req.user?.platform_id || 'unidentified'}`);
            await nukeDatabase();
            res.json({ success: true, message: 'Base de données réinitialisée.' });
        } catch (e) {
            debugLog(`[ADMIN-FATAL] Nuke failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/livreurs', authMiddleware, async (req, res) => {
        try {
            const dbModule = require('./services/database');
            const { supabase, COL_USERS } = dbModule;
            const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
            const livreurs = (data || []).map(d => {
                try { return dbModule.decryptUser({ ...d, doc_id: d.id }); }
                catch { return { ...d, doc_id: d.id }; }
            });
            res.json(livreurs);
        } catch (e) { console.error('Livreurs API error:', e); res.status(500).json({ error: e.message }); }
    });

    app.get('/api/settings', authMiddleware, async (req, res) => {
        try { res.json(await getAppSettings()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/settings', authMiddleware, async (req, res) => {
        try {
            const updates = { ...req.body };
            if (!updates.admin_password || updates.admin_password.trim() === '') {
                delete updates.admin_password;
            }
            await updateAppSettings(updates);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/orders/status', authMiddleware, async (req, res) => {
        try {
            const { orderId, status } = req.body;
            const order = await getOrder(orderId);
            if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

            await updateOrderStatus(orderId, status);

            // Notification Client Automatisée
            if (order.user_id && order.user_id.startsWith('telegram_')) {
                const tgId = order.user_id.replace('telegram_', '');
                const bot = getBotInstance();
                if (bot) {
                    const settings = await getAppSettings();
                    let text = '';
                    const shortId = orderId.substring(0, 5);

                    const statusLabel = (status === 'delivered' ? settings.status_delivered_label :
                        (status === 'pending' ? settings.status_pending_label :
                            (status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label))) || status.toUpperCase();

                    const statusIcon = (status === 'delivered' ? settings.ui_icon_success :
                        (status === 'pending' ? settings.ui_icon_pending :
                            (status === 'taken' ? (settings.ui_icon_taken || '🚚') : settings.ui_icon_error))) || '🔔';

                    switch (status) {
                        case 'delivered':
                            text = `${statusIcon} <b>Commande #${shortId} ${statusLabel} !</b>\n\nCelle-ci vient d'être marquée comme livrée. Merci de votre confiance et à bientôt ! 🚀`;
                            break;
                        case 'taken':
                            text = `${statusIcon} <b>Commande #${shortId} ${statusLabel} !</b>\n\nUn livreur a pris en charge votre commande et arrive vers vous. 💨`;
                            break;
                        case 'arrival_10min':
                            text = `⏳ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>10 min</b> ! Préparez-vous. 🛵`;
                            break;
                        case 'arrival_5min':
                            text = `⚡ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>5 min</b> ! Soyez prêt(e). 🔥`;
                            break;
                        case 'arrived':
                            text = `📍 <b>Commande #${shortId}</b>\n\n<b>Votre livreur est arrivé !</b> Il vous attend sur place. ✅`;
                            break;
                        case 'cancelled':
                            text = `${settings.ui_icon_error} <b>${statusLabel} de commande</b>\n\nVotre commande #${shortId} a été annulée par l'administration.`;
                            break;
                        case 'pending':
                            text = `${settings.ui_icon_pending} <b>Mise à jour de commande</b>\n\nVotre commande #${shortId} est de nouveau ${statusLabel}.`;
                            break;
                    }
                    if (text) bot.telegram.sendMessage(tgId, text, { parse_mode: 'HTML' }).catch(() => { });
                }
            }

            res.json({ success: true });
        } catch (e) { console.error('Order Status API error:', e); res.status(500).json({ error: 'Erreur serveur' }); }
    });

    /**
     * Broadcast - accepte FormData avec fichiers médias
     */
    app.post('/api/broadcast', authMiddleware, async (req, res) => {
        try {
            const message = req.body.message || '';
            const platform = req.body.platform || 'all';
            const mediaCount = parseInt(req.body.media_count) || 0;

            // Extraire les fichiers médias
            const mediaFiles = [];
            if (req.files) {
                const fs = require('fs');
                debugLog(`[API-BC] Reçu de ${mediaCount} fichiers attendus.`);
                for (let i = 0; i < mediaCount; i++) {
                    const f = req.files[`media_${i}`];
                    if (f) {
                        try {
                            const fileData = f.tempFilePath ? fs.readFileSync(f.tempFilePath) : f.data;
                            if (fileData && fileData.length > 0) {
                                mediaFiles.push({ data: fileData, mimetype: f.mimetype, name: f.name });
                                debugLog(`[API-BC] Fichier ${i} prêt: ${f.name} (${f.mimetype}, ${fileData.length} octets)`);
                            }
                        } catch (err) {
                            debugLog(`[API-BC-ERR] Lecture fichier ${i}: ${err.message}`);
                        }
                    } else {
                        debugLog(`[API-BC-WARN] media_${i} manquant dans req.files`);
                    }
                }
            }

            if (!message && mediaFiles.length === 0) {
                return res.status(400).json({ error: 'Message ou média requis' });
            }

            debugLog(`[API-BC-OK] Lancement: "${message.substring(0, 20)}..." Platform: ${platform}, Médias: ${mediaFiles.length}`);
            res.json({ status: 'started', media_count: mediaFiles.length });

            // Lancer la diffusion
            broadcastMessage(platform, message, { mediaFiles }).catch(err => {
                debugLog(`[API-BC-FATAL] ${err.message}`);
            });
        } catch (e) {
            debugLog(`[API-BC-CRITICAL] ${e.message}`);
            res.status(500).json({ error: 'Erreur broadcast' });
        }
    });

    app.use('/api/*', (req, res) => {
        res.status(404).json({ error: 'Route API non trouvée' });
    });

    return app;
}

module.exports = { createServer, setBotInstance };
