const { db, admin } = require('../config/firebase');
const encryption = require('./encryption');

const COL_USERS = 'bot_users';
const COL_BROADCASTS = 'bot_broadcasts';
const COL_STATS = 'bot_stats';
const COL_REFERRALS = 'bot_referrals';
const COL_SETTINGS = 'bot_settings';
const COL_PRODUCTS = 'bot_products';
const COL_ORDERS = 'bot_orders';
function ts() { return admin.firestore.FieldValue.serverTimestamp(); }
function incr(n = 1) { return admin.firestore.FieldValue.increment(n); }
function decryptUser(userData) {
    if (!userData) return null;
    return {
        ...userData,
        username: encryption.decrypt(userData.username),
        first_name: encryption.decrypt(userData.first_name),
        last_name: encryption.decrypt(userData.last_name),
    };
}
function makeDocId(platform, platformId) { return `${platform}_${platformId}`; }

function activeUsersQuery(platform, type = null) {
    let q = db.collection(COL_USERS).where('is_blocked', '==', false).where('is_active', '==', true);
    if (platform) q = q.where('platform', '==', platform);
    if (type) q = q.where('type', '==', type);
    return q;
}

async function registerUser(platformUser, platform = 'telegram', referrerId = null) {
    if (!platform) platform = 'telegram'; // Sécurité si l'argument est passé explicitement à null
    const docId = makeDocId(platform, platformUser.id);
    const userRef = db.collection(COL_USERS).doc(docId);
    const existing = await userRef.get();
    const isGroup = platformUser.type === 'group' || platformUser.type === 'supergroup';
    const coreData = {
        platform,
        platform_id: String(platformUser.id),
        type: isGroup ? 'group' : 'user',
        username: !isGroup ? encryption.encrypt(platformUser.username || '') : (platformUser.username || ''),
        first_name: !isGroup ? encryption.encrypt(platformUser.first_name || '') : (platformUser.title || ''),
        last_name: !isGroup ? encryption.encrypt(platformUser.last_name || '') : '',
        language_code: platformUser.language_code || 'fr',
        last_active: ts(),
        updated_at: ts(),
        is_active: true,
        is_blocked: false,
    };
    if (existing.exists) {
        await userRef.update(coreData);
        return { isNew: false, user: decryptUser({ ...existing.data(), ...coreData, doc_id: docId }) };
    }
    const newUser = {
        ...coreData, doc_id: docId, date_inscription: ts(),
        is_blocked: false, is_active: true,
        referred_by: referrerId || null, referral_count: 0,
        order_count: 0, points: 0, wallet_balance: 0, // <-- Nouveaux champs
        referral_code: generateReferralCode(platform, platformUser.id),
    };
    await userRef.set(newUser);
    await incrementStat('total_users');
    await incrementDailyStat('new_users');
    if (referrerId) {
        try {
            const snap = await db.collection(COL_USERS).where('referral_code', '==', referrerId).limit(1).get();
            if (!snap.empty) {
                const referrerDoc = snap.docs[0];
                await referrerDoc.ref.update({ referral_count: incr() });
                await db.collection(COL_REFERRALS).add({ referrer_id: referrerDoc.id, referred_id: docId, created_at: ts() });
                await incrementStat('total_referrals');
            }
        } catch (e) { console.error("Error processing referral:", e.message); }
    }
    return { isNew: true, user: decryptUser(newUser) };
}

async function getAllActiveUsers(platform = null, type = 'user') {
    const snapshot = await activeUsersQuery(platform, type).get();
    const list = snapshot.docs.map((d) => decryptUser(d.data()));
    console.log(`[DB] getAllActiveUsers(platform=${platform}, type=${type}) -> ${list.length} trouvés`);
    return list;
}
async function markUserBlocked(docId) {
    await db.collection(COL_USERS).doc(docId).update({ is_blocked: true, blocked_at: ts() });
}
async function deleteUser(docId) {
    await db.collection(COL_USERS).doc(docId).delete();
}
async function incrementOrderCount(docId) {
    await db.collection(COL_USERS).doc(docId).update({ order_count: incr() });
}

// --- Livreurs ---
async function setLivreurStatus(userId, platform, isLivreur) {
    const docId = makeDocId(platform, userId);
    await db.collection(COL_USERS).doc(docId).update({
        is_livreur: isLivreur,
        is_available: isLivreur, // Par défaut dispo si promu
        updated_at: ts()
    });
}
async function setLivreurAvailability(docId, isAvailable) {
    await db.collection(COL_USERS).doc(docId).update({
        is_available: isAvailable,
        updated_at: ts()
    });
}
async function updateLivreurPosition(docId, input) {
    // Si c'est une chaîne avec des virgules, transformer en tableau
    const sectors = input.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
    await db.collection(COL_USERS).doc(docId).update({
        current_city: input.toLowerCase(), // Pour la compatibilité
        sectors: sectors, // Liste des zones couvertes
        last_position_update: ts()
    });
}
async function saveUserLocation(docId, lat, lon, city = null) {
    const updates = {
        latitude: lat,
        longitude: lon,
        last_gps_update: ts()
    };
    if (city) updates.current_city = city.toLowerCase();
    await db.collection(COL_USERS).doc(docId).update(updates);
}
async function getActiveLivreursCount() {
    const snap = await db.collection(COL_USERS)
        .where('is_livreur', '==', true)
        .where('is_active', '==', true)
        .get();
    return snap.size;
}

async function addMessageToTrack(docId, messageId) {
    const ref = db.collection(COL_USERS).doc(docId);
    await ref.update({
        tracked_messages: admin.firestore.FieldValue.arrayUnion(messageId),
        last_menu_id: messageId
    }).catch(() => { });
}

async function getLastMenuId(docId) {
    const doc = await db.collection(COL_USERS).doc(docId).get();
    return doc.exists ? doc.data().last_menu_id : null;
}

// --- Orders ---
async function createOrder(orderData) {
    const ref = await db.collection(COL_ORDERS).add({
        ...orderData,
        status: 'pending', // pending, taken, delivered, cancelled
        created_at: ts()
    });
    await incrementStat('total_orders');
    return ref.id;
}
async function updateOrderStatus(orderId, status, extraData = {}) {
    if (status === 'delivered') {
        extraData.delivered_at = ts(); // Horodatage livraison
        const orderDoc = await db.collection(COL_ORDERS).doc(orderId).get();
        const order = orderDoc.data();
        if (order && !order.points_awarded) {
            const userRef = db.collection(COL_USERS).doc(order.user_id);
            const userDoc = await userRef.get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const price = parseFloat(order.total_price) || 0;

                const settings = await getAppSettings();
                const pointsRatio = settings.points_ratio || 1;
                const refBonus = settings.ref_bonus || 5;

                const pointsToAdd = Math.floor(price * pointsRatio);
                const isFirstOrder = userData.order_count === 0;

                const updates = {
                    points: incr(pointsToAdd),
                    order_count: incr(1)
                };

                // Bonus Parrainage
                if (isFirstOrder && userData.referred_by) {
                    updates.wallet_balance = incr(refBonus);
                    const referrerRef = db.collection(COL_USERS).doc(userData.referred_by);
                    await referrerRef.update({ wallet_balance: incr(refBonus) }).catch(() => { });
                }

                await userRef.update(updates);
                extraData.points_awarded = true;
            }
        }
    }

    await db.collection(COL_ORDERS).doc(orderId).update({
        status,
        ...extraData,
        updated_at: ts()
    });
}
async function getOrder(orderId) {
    const doc = await db.collection(COL_ORDERS).doc(orderId).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
}
async function getAvailableOrdersByCity(city) {
    const snap = await db.collection(COL_ORDERS)
        .where('status', '==', 'pending')
        .where('city', '==', city.toLowerCase())
        .orderBy('created_at', 'desc')
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function getAllOrders(limit = 50) {
    const snap = await db.collection(COL_ORDERS).orderBy('created_at', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function getLivreurOrders(livreurId) {
    const snap = await db.collection(COL_ORDERS)
        .where('livreur_id', '==', livreurId)
        .where('status', '==', 'taken')
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function getUser(docId) {
    const doc = await db.collection(COL_USERS).doc(docId).get();
    return doc.exists ? decryptUser(doc.data()) : null;
}
async function getUserCount(platform = null) {
    const base = db.collection(COL_USERS);
    const q = platform ? base.where('platform', '==', platform) : base;
    return (await q.count().get()).data().count;
}
async function getActiveUserCount(platform = null) {
    return (await activeUsersQuery(platform).count().get()).data().count;
}
async function getRecentUsers(limit = 20) {
    const snap = await db.collection(COL_USERS).orderBy('date_inscription', 'desc').limit(limit).get();
    return snap.docs.map((d) => decryptUser(d.data()));
}
async function searchUsers(query) {
    if (isNaN(query)) return [];
    const user = await getUser(`telegram_${query}`);
    return user ? [user] : [];
}

// --- Referral ---
function generateReferralCode(platform, platformId) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return `ref_${platform}_${platformId}_${code}`;
}
// Reference to processReferral removed since implementation is now inside registerUser
async function getReferralLeaderboard(limit = 10) {
    const snap = await db.collection(COL_USERS)
        .where('referral_count', '>', 0).orderBy('referral_count', 'desc').limit(limit).get();
    return snap.docs.map((d) => decryptUser(d.data()));
}

// --- Stats ---
async function incrementStat(name) {
    await db.collection(COL_STATS).doc('global').set({ [name]: incr() }, { merge: true });
}
async function incrementDailyStat(name) {
    const today = new Date().toISOString().split('T')[0];
    await db.collection(COL_STATS).doc(`daily_${today}`).set({ date: today, [name]: incr() }, { merge: true });
}
async function getGlobalStats() {
    const doc = await db.collection(COL_STATS).doc('global').get();
    return doc.exists ? doc.data() : {};
}
async function getDailyStats(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const snap = await db.collection(COL_STATS)
        .where('date', '>=', cutoff.toISOString().split('T')[0]).orderBy('date', 'asc').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function getStatsOverview() {
    const [total, active, stats, bcSnap, ordersSnap, livreursSnap] = await Promise.all([
        getUserCount(),
        getActiveUserCount(),
        getGlobalStats(),
        db.collection(COL_BROADCASTS).orderBy('created_at', 'desc').limit(5).get(),
        db.collection(COL_ORDERS).get(),
        db.collection(COL_USERS).where('is_livreur', '==', true).get()
    ]);

    let totalCA = 0;
    ordersSnap.docs.forEach(d => {
        const order = d.data();
        if (order.status === 'delivered') {
            totalCA += (parseFloat(order.total_price) || 0);
        }
    });

    const activeLivreurs = livreursSnap.docs.filter(d => d.data().is_available === true).length;

    return {
        totalUsers: total,
        activeUsers: active,
        totalStats: stats,
        totalOrders: ordersSnap.size,
        totalCA: totalCA.toFixed(2),
        totalLivreurs: livreursSnap.size,
        activeLivreurs: activeLivreurs,
        recentBroadcasts: bcSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    };
}

/**
 * Agrège les données pour le dashboard analytics
 */
async function getOrderAnalytics() {
    const ordersSnap = await db.collection(COL_ORDERS).get();
    const analytics = {
        totalCA: 0,
        totalOrders: 0,
        avgDeliveryTime: 0,  // Temps moyen de livraison en minutes
        byHour: {},
        byDay: {},
        byWeek: {},
        byMonth: {},
        byYear: {},
        byCity: {},
        byLivreur: {},
        byClient: {},
        rawDelivered: []
    };

    let totalDeliveryMinutes = 0;
    let deliveryCount = 0;

    ordersSnap.forEach(doc => {
        const order = { id: doc.id, ...doc.data() };
        if (order.status !== 'delivered') return;

        const price = parseFloat(order.total_price) || 0;
        analytics.totalCA += price;
        analytics.totalOrders++;

        // Calcul temps de livraison
        let deliveryMinutes = null;
        if (order.created_at && order.delivered_at) {
            const createdMs = order.created_at._seconds * 1000;
            const deliveredMs = order.delivered_at._seconds * 1000;
            deliveryMinutes = Math.round((deliveredMs - createdMs) / 60000);
            if (deliveryMinutes > 0 && deliveryMinutes < 1440) { // Jusqu'à 24h
                totalDeliveryMinutes += deliveryMinutes;
                deliveryCount++;
            }
        }

        // Client
        const clientId = order.user_id || 'unknown';
        const clientName = order.first_name || order.username || 'Client Inconnu';
        if (!analytics.byClient[clientId]) {
            analytics.byClient[clientId] = { name: clientName, ca: 0, orders: 0 };
        }
        analytics.byClient[clientId].ca += price;
        analytics.byClient[clientId].orders++;

        // Temps
        if (order.created_at) {
            const date = new Date(order.created_at._seconds * 1000);

            const hour = date.getHours() + 'h';
            analytics.byHour[hour] = (analytics.byHour[hour] || 0) + price;

            const day = date.toISOString().split('T')[0];
            analytics.byDay[day] = (analytics.byDay[day] || 0) + price;

            const year = date.getFullYear();
            const oneJan = new Date(year, 0, 1);
            const weekNum = Math.ceil((((date - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
            const weekKey = `${year}-W${weekNum}`;
            analytics.byWeek[weekKey] = (analytics.byWeek[weekKey] || 0) + price;

            const month = date.toISOString().substring(0, 7);
            analytics.byMonth[month] = (analytics.byMonth[month] || 0) + price;

            const yr = date.getFullYear().toString();
            analytics.byYear[yr] = (analytics.byYear[yr] || 0) + price;
        }

        const city = (order.city || 'Inconnue').split(',')[0].trim().toUpperCase();
        analytics.byCity[city] = (analytics.byCity[city] || 0) + price;

        if (order.livreur_name) {
            analytics.byLivreur[order.livreur_name] = (analytics.byLivreur[order.livreur_name] || 0) + price;
        }

        analytics.rawDelivered.push({
            id: order.id,
            date: order.created_at ? new Date(order.created_at._seconds * 1000).toLocaleString('fr-FR') : '?',
            delivered_date: order.delivered_at ? new Date(order.delivered_at._seconds * 1000).toLocaleString('fr-FR') : null,
            delivery_time: deliveryMinutes,
            client: clientName,
            product: order.product_name,
            qty: order.quantity,
            price: price,
            city: city,
            livreur: order.livreur_name || 'N/A'
        });
    });

    analytics.avgDeliveryTime = deliveryCount > 0 ? Math.round(totalDeliveryMinutes / deliveryCount) : 0;

    return analytics;
}

async function getAvailableLivreurs(city = null) {
    let q = db.collection(COL_USERS).where('is_livreur', '==', true).where('is_available', '==', true);
    if (city) {
        q = q.where('current_city', '==', city.toLowerCase());
    }
    const snapshot = await q.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// --- Settings ---
const SETTINGS_DEFAULTS = {
    bot_name: 'La Frappe IDF',
    welcome_message: 'Bienvenue ! Vous faites partie de la famille.',
    admin_password: process.env.ADMIN_PASSWORD || 'admin123456',
    admin_telegram_id: String(process.env.ADMIN_TELEGRAM_ID || ''),

    // --- Composants UI (Emojis & Icônes) ---
    ui_icon_catalog: '🍔',
    ui_icon_orders: '📦',
    ui_icon_contact: '📱',
    ui_icon_channel: '📢',
    ui_icon_welcome: '🏠',
    ui_icon_profile: '🎁',
    ui_icon_admin: '🛠',
    ui_icon_web: '🔐',
    ui_icon_livreur: '🚴',
    ui_icon_success: '✅',
    ui_icon_error: '❌',
    ui_icon_pending: '⏳',
    ui_icon_notification: '🔔',
    ui_icon_wallet: '💰',
    ui_icon_points: '⭐',
    ui_icon_stats: '📊',
    ui_icon_broadcast: '📢',
    ui_icon_logout: '🚪',

    // --- Libellés Boutons (Navigation) ---
    label_catalog: 'Catalogue Produits',
    label_my_orders: 'Mes Commandes',
    label_contact: 'Mon contact privé',
    label_channel: 'Lien canal Telegram',
    label_welcome: 'Message d\'accueil',
    label_profile: 'Mon Profil & Parrainage',
    label_admin_bot: 'Console Admin (Bot)',
    label_admin_web: 'Dashboard Web',
    label_livreur_space: 'Espace Livreur',

    // --- Statuts Commande ---
    status_pending_label: 'EN ATTENTE',
    status_taken_label: 'PRIS EN CHARGE',
    status_delivered_label: 'LIVRÉE',
    status_cancelled_label: 'ANNULÉE',
    msg_auto_timer: '🔥 <b>Le catalogue est à jour !</b>\nProfitez de nos nouveaux produits et de nos promos en cours. 🚀',
    ui_icon_taken: '🚚',

    // --- Template Messages ---
    msg_choose_qty: 'Choisissez la quantité :',
    msg_search_livreur: '⏳ Recherche d\'un livreur en cours...',
    msg_order_success: '✅ <b>Commande enregistrée !</b>'
};
async function getAppSettings() {
    const ref = db.collection(COL_SETTINGS).doc('config');
    const doc = await ref.get();
    if (!doc.exists) { await ref.set(SETTINGS_DEFAULTS); return SETTINGS_DEFAULTS; }
    return { ...SETTINGS_DEFAULTS, ...doc.data() };
}
async function updateAppSettings(settings) {
    await db.collection(COL_SETTINGS).doc('config').update(settings);
}

// --- Products ---
async function getProducts() {
    const snap = await db.collection(COL_PRODUCTS).get();
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}
async function saveProduct(data) {
    const id = data.id;
    delete data.id;
    if (id) {
        await db.collection(COL_PRODUCTS).doc(id).update(data);
        return id;
    }
    const ref = await db.collection(COL_PRODUCTS).add({ ...data, created_at: ts() });
    return ref.id;
}
async function deleteProduct(id) {
    await db.collection(COL_PRODUCTS).doc(id).delete();
}

// --- Broadcasts ---
async function saveBroadcast(data) {
    const ref = await db.collection(COL_BROADCASTS).add({ ...data, created_at: ts() });
    return ref.id;
}
async function updateBroadcast(broadcastId, data) {
    await db.collection(COL_BROADCASTS).doc(broadcastId).update(data);
}

module.exports = {
    db, incr, ts, makeDocId, decryptUser,
    registerUser, getAllActiveUsers, markUserBlocked, deleteUser, getUser,
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers,
    generateReferralCode, getReferralLeaderboard, incrementOrderCount,
    setLivreurStatus, updateLivreurPosition, getActiveLivreursCount,
    createOrder, updateOrderStatus, getOrder, getAvailableOrdersByCity, getAllOrders,
    saveBroadcast, updateBroadcast, incrementStat, incrementDailyStat,
    getGlobalStats, getDailyStats, getStatsOverview, getAppSettings, updateAppSettings,
    getProducts, saveProduct, deleteProduct, setLivreurAvailability,
    getAvailableLivreurs, getOrderAnalytics, saveUserLocation, addMessageToTrack, getLastMenuId, getLivreurOrders
};
