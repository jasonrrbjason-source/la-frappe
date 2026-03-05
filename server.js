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
    deleteUser, incrementOrderCount, makeDocId, getOrderAnalytics
} = require('./services/database');
const { broadcastMessage } = require('./services/broadcast');
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
            const fs = require('fs');
            const ext = path.extname(file.name) || (file.mimetype.includes('video') ? '.mp4' : '.jpg');
            const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
            const dir = path.resolve(__dirname, 'web', 'public', 'uploads');
            const uploadPath = path.join(dir, fileName);

            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // Robust move
            await file.mv(uploadPath);

            if (!fs.existsSync(uploadPath)) {
                throw new Error("Le fichier n'a pas pu être sauvegardé sur le disque.");
            }

            const url = `/public/uploads/${fileName}`;
            console.log(`[UPLOAD] ✅ Fichier sauvegardé physiquement : ${uploadPath} -> accessible via ${url}`);
            res.json({ success: true, url });
        } catch (e) {
            console.error('Upload error:', e.message);
            res.status(500).json({ error: e.message });
        }
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

    app.get('/api/livreurs', authMiddleware, async (req, res) => {
        try {
            const dbModule = require('./services/database');
            const snap = await dbModule.db.collection('bot_users').where('is_livreur', '==', true).get();
            const livreurs = snap.docs.map(d => {
                const data = d.data();
                try { return dbModule.decryptUser({ ...data, doc_id: d.id }); }
                catch { return { ...data, doc_id: d.id }; }
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
                for (let i = 0; i < mediaCount; i++) {
                    const f = req.files[`media_${i}`];
                    if (f) {
                        const fileData = f.tempFilePath ? fs.readFileSync(f.tempFilePath) : f.data;
                        mediaFiles.push({ data: fileData, mimetype: f.mimetype, name: f.name });
                    }
                }
            }

            if (!message && mediaFiles.length === 0) {
                return res.status(400).json({ error: 'Message ou média requis' });
            }

            res.json({ status: 'started', media_count: mediaFiles.length });
            broadcastMessage(platform, message, { mediaFiles }).catch(console.error);
        } catch (e) {
            console.error('API Broadcast error:', e);
            res.status(500).json({ error: 'Erreur broadcast' });
        }
    });

    app.use('/api/*', (req, res) => {
        res.status(404).json({ error: 'Route API non trouvée' });
    });

    return app;
}

module.exports = { createServer, setBotInstance };
