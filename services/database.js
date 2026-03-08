const { supabase } = require('../config/supabase');
const encryption = require('./encryption');

const COL_USERS = 'bot_users';
const COL_BROADCASTS = 'bot_broadcasts';
const COL_STATS = 'bot_stats';
const COL_REFERRALS = 'bot_referrals';
const COL_SETTINGS = 'bot_settings';
const COL_PRODUCTS = 'bot_products';
const COL_ORDERS = 'bot_orders';
const COL_DAILY_STATS = 'bot_daily_stats';
const COL_REVIEWS = 'bot_reviews';

function ts() { return new Date().toISOString(); }

// Simple server-side cache to avoid heavy DB scans on every refresh
const _statsCache = {
    overview: null,
    analytics: null,
    ttl: 30000, // 30 seconds
    lastOverview: 0,
    lastAnalytics: 0
};

// Helper pour simplifier Supabase updates numériques
const incr = (n = 1) => n;
function decryptUser(userData) {
    if (!userData) return null;
    const decrypted = {
        ...userData,
        doc_id: userData.id,
        username: encryption.decrypt(userData.username),
        first_name: encryption.decrypt(userData.first_name),
        last_name: encryption.decrypt(userData.last_name),
    };

    // Parse JSONB data field
    let meta = userData.data;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
    }
    if (!meta || typeof meta !== 'object') meta = {};
    decrypted.data = meta;

    // is_available: JSONB wins, then root column, then false
    if (meta.is_available !== undefined) {
        decrypted.is_available = !!meta.is_available;
    } else {
        decrypted.is_available = !!userData.is_available;
    }

    // current_city: JSONB wins, then root column, then null
    if (meta.current_city) {
        decrypted.current_city = meta.current_city;
    } else if (userData.current_city) {
        decrypted.current_city = userData.current_city;
    } else {
        decrypted.current_city = null;
    }

    return decrypted;
}
function makeDocId(platform, platformId) { return `${platform}_${platformId}`; }

async function activeUsersQuery(platform, type = null, limit = null) {
    let q = supabase.from(COL_USERS).select('id, platform, platform_id, type, username, first_name, last_name, order_count, wallet_balance, points, date_inscription, is_livreur, is_available, is_blocked, current_city, data').eq('is_blocked', false);
    if (platform && platform !== 'all') q = q.eq('platform', platform);
    if (type === 'livreurs') {
        q = q.eq('is_livreur', true);
    } else if (type === 'user') {
        // Inclure 'user' OU NULL (si non défini) mais exclure explicitement 'group'
        q = q.or('type.is.null,type.eq.user');
    } else if (type === 'group') {
        q = q.eq('type', 'group');
    } else if (type) {
        q = q.eq('type', type);
    }
    if (limit) q = q.limit(limit);
    const { data } = await q;
    return data || [];
}

const _userCache = new Map();

async function registerUser(platformUser, platform = 'telegram', referrerId = null) {
    if (!platform) platform = 'telegram';
    const docId = makeDocId(platform, platformUser.id);
    const nowMs = Date.now();

    let existing = null;
    if (_userCache.has(docId)) {
        existing = _userCache.get(docId).data;
    } else {
        const { data: existingArray } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
        existing = existingArray && existingArray.length > 0 ? existingArray[0] : null;
    }

    const isGroup = platformUser.type === 'group' || platformUser.type === 'supergroup';

    // Si l'utilisateur existe déjà
    if (existing) {
        // Optimisation : Ne mettre à jour last_active en DB que toutes les 5 minutes
        const lastUpdated = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const needsDbUpdate = (nowMs - lastUpdated) > 300000; // 5 minutes
        const needsTypeHealing = !existing.type;

        if (needsDbUpdate || needsTypeHealing) {
            const updateData = {
                last_active: ts(),
                updated_at: ts(),
                is_active: true
            };

            if (needsTypeHealing) updateData.type = isGroup ? 'group' : 'user';

            // Si on a des infos fraîches sur le nom/username
            if (platformUser.username) updateData.username = !isGroup ? encryption.encrypt(platformUser.username) : platformUser.username;
            if (platformUser.first_name) updateData.first_name = !isGroup ? encryption.encrypt(platformUser.first_name) : platformUser.first_name;

            // Update en tâche de fond (background) pour ne pas ralentir le bot
            supabase.from(COL_USERS).update(updateData).eq('id', docId).then(() => { }).catch(() => { });

            const updatedUser = { ...existing, ...updateData };
            _userCache.set(docId, { data: updatedUser, expire: nowMs + 300000 });
            return { isNew: false, user: decryptUser(updatedUser) };
        }

        return { isNew: false, user: decryptUser(existing) };
    }

    // Nouvel utilisateur
    const newUser = {
        id: docId,
        doc_id: docId,
        platform,
        platform_id: String(platformUser.id || ''),
        type: isGroup ? 'group' : 'user',
        username: !isGroup ? encryption.encrypt(platformUser.username || '') : (platformUser.username || ''),
        first_name: !isGroup ? encryption.encrypt(platformUser.first_name || 'Utilisateur') : (platformUser.first_name || 'Utilisateur'),
        last_name: !isGroup ? encryption.encrypt(platformUser.last_name || '') : '',
        language_code: platformUser.language_code || 'fr',
        date_inscription: ts(),
        last_active: ts(),
        updated_at: ts(),
        is_active: true,
        is_blocked: false,
        referred_by: referrerId || null,
        referral_count: 0,
        order_count: 0,
        points: 0,
        wallet_balance: 0,
        is_available: false,
        current_city: null,
        data: {},
        referral_code: generateReferralCode(platform, platformUser.id || Date.now()),
    };

    const { error: insertError } = await supabase.from(COL_USERS).insert([newUser]);
    if (insertError) {
        if (insertError.code === '23505') {
            const { data: updatedArray } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
            if (updatedArray && updatedArray.length > 0) {
                return { isNew: false, user: decryptUser(updatedArray[0]) };
            }
        }
        console.error(`❌ Échec INSERT user ${docId}:`, insertError.message);
        throw new Error(`Impossible d'enregistrer l'utilisateur : ${insertError.message}`);
    }

    // Statistiques
    await incrementStat('total_users').catch(() => { });
    await incrementDailyStat('new_users').catch(() => { });

    _userCache.set(docId, { data: newUser, expire: nowMs + 300000 });

    if (referrerId) {
        try {
            const { data: refDocs } = await supabase.from(COL_USERS).select('*').eq('referral_code', referrerId).limit(1);
            if (refDocs && refDocs.length > 0) {
                const referrerDoc = refDocs[0];
                await supabase.from(COL_USERS).update({
                    referral_count: (referrerDoc.referral_count || 0) + 1
                }).eq('id', referrerDoc.id);
                _userCache.delete(referrerDoc.id);
                await supabase.from(COL_REFERRALS).insert([{
                    id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
                    referrer_id: referrerDoc.id,
                    referred_id: docId,
                    created_at: ts()
                }]).catch(() => { });
                await incrementStat('total_referrals').catch(() => { });
            }
        } catch (e) {
            console.error("Error processing referral:", e.message);
        }
    }

    return { isNew: true, user: decryptUser(newUser) };
}

async function getAllActiveUsers(platform = null, type = null) {
    const list = await activeUsersQuery(platform, type);
    console.log(`[DB] getAllActiveUsers(platform=${platform}, type=${type}) -> ${list.length} trouvés`);
    return list.map(d => decryptUser(d));
}

// Nouvelle fonction pour le broadcast : inclut TOUS les utilisateurs (même bloqués)
async function getAllUsersForBroadcast(platform = null, type = null) {
    let q = supabase.from(COL_USERS).select('id, platform, platform_id, type, username, first_name, last_name, order_count, wallet_balance, points, date_inscription, is_livreur, is_available, is_blocked, current_city, data, blocked_at');
    if (platform && platform !== 'all') q = q.eq('platform', platform);
    if (type === 'livreurs') {
        q = q.eq('is_livreur', true);
    } else if (type === 'user') {
        q = q.or('type.is.null,type.eq.user');
    } else if (type === 'group') {
        q = q.eq('type', 'group');
    } else if (type) {
        q = q.eq('type', type);
    }
    const { data } = await q;
    const list = data || [];
    console.log(`[DB] getAllUsersForBroadcast(platform=${platform}, type=${type}) -> ${list.length} trouvés (dont bloqués)`);
    return list.map(d => decryptUser(d));
}
async function markUserBlocked(docId) {
    await supabase.from(COL_USERS).update({ is_blocked: true, blocked_at: ts() }).eq('id', docId);
    _userCache.delete(docId);
}
async function markUserUnblocked(docId) {
    await supabase.from(COL_USERS).update({ is_blocked: false, blocked_at: null }).eq('id', docId);
    _userCache.delete(docId);
}
async function deleteUser(docId) {
    await supabase.from(COL_USERS).delete().eq('id', docId);
}
async function incrementOrderCount(docId) {
    const user = await getUser(docId);
    if (user) await supabase.from(COL_USERS).update({ order_count: (user.order_count || 0) + 1 }).eq('id', docId);
    _userCache.delete(docId);
}

async function updateUserWallet(docId, amount) {
    await supabase.from(COL_USERS).update({ wallet_balance: parseFloat(amount) }).eq('id', docId);
    _userCache.delete(docId);
}

async function updateUserPoints(docId, points) {
    points = parseFloat(points) || 0;
    await supabase.from(COL_USERS).update({ points }).eq('id', docId);
    _userCache.delete(docId);

    // Trigger conversion if threshold reached
    const settings = await getAppSettings();
    const threshold = settings.points_exchange || 100;
    const creditValue = settings.points_credit_value || 5;

    if (points >= threshold) {
        const conversions = Math.floor(points / threshold);
        const pointsToDeduce = conversions * threshold;
        const creditToAdd = conversions * creditValue;

        const user = await getUser(docId);
        if (user) {
            await supabase.from(COL_USERS).update({
                points: points - pointsToDeduce,
                wallet_balance: (user.wallet_balance || 0) + creditToAdd
            }).eq('id', docId);
            _userCache.delete(docId);

            try {
                const { getBotInstance } = require('../server');
                const bot = getBotInstance();
                if (bot && user.platform_id) {
                    bot.telegram.sendMessage(user.platform_id, `🎊 <b>Conversion Automatique !</b>\n\nVos ${pointsToDeduce} points ont été convertis en <b>${creditToAdd}€</b> de crédit.\nNouveau solde : <b>${((user.wallet_balance || 0) + creditToAdd).toFixed(2)}€</b> 🚀`, { parse_mode: 'HTML' }).catch(() => { });
                }
            } catch (e) { }
        }
    }
}

// --- Livreurs ---
async function setLivreurStatus(userId, platform, isLivreur) {
    const docId = makeDocId(platform, userId);
    const { error } = await supabase.from(COL_USERS).update({
        is_livreur: isLivreur,
        updated_at: ts()
    }).eq('id', docId);

    if (error) throw new Error(error.message);
    _userCache.delete(docId);
}
async function setLivreurAvailability(docId, isAvailable) {
    const updates = {
        is_available: !!isAvailable,
        updated_at: ts()
    };

    const { data: updated, error: fullError } = await supabase.from(COL_USERS).update(updates).eq('id', docId).select();
    if (fullError) {
        console.error(`❌ DB Error setLivreurAvailability: ${fullError.message}`);
        throw new Error(fullError.message);
    }
    if (updated) console.log(`[DB] Updated row count: ${updated.length}`);

    _userCache.delete(docId);
}

async function updateLivreurPosition(docId, input) {
    const user = await getUser(docId);
    if (!user) return;
    const city = input.toLowerCase();
    const sectors = city.split(',').map(s => s.trim()).filter(s => s.length > 0);

    let meta = user.data || {};
    meta.sectors = sectors;
    meta.current_city = city;
    meta.last_position_update = ts();

    // 1. On ne touche plus à is_available ici pour les séparer
    const updates = {
        current_city: city,
        updated_at: ts()
    };

    const { data: updated, error: fullError } = await supabase.from(COL_USERS).update(updates).eq('id', docId).select();
    if (fullError) {
        console.error(`❌ DB Error updateLivreurPosition: ${fullError.message}`);
        throw new Error(fullError.message);
    }
    if (updated) console.log(`[DB] Updated row count: ${updated.length} for ID: ${docId}`);

    _userCache.delete(docId);
}

async function saveUserLocation(docId, lat, lon, city = null) {
    const user = await getUser(docId);
    if (!user) return;
    let tracked = user.data || {};
    tracked.latitude = lat;
    tracked.longitude = lon;
    tracked.last_gps_update = ts();
    if (city) tracked.current_city = city.toLowerCase();
    await supabase.from(COL_USERS).update({ data: tracked }).eq('id', docId);
    _userCache.delete(docId);
}

async function getActiveLivreursCount() {
    const { data } = await supabase.from(COL_USERS).select('*')
        .eq('is_livreur', true);

    // Check JSONB for is_available as well
    const available = (data || []).map(d => decryptUser(d)).filter(u => u.is_available === true);
    return available.length;
}

async function addMessageToTrack(docId, messageId) {
    const user = await getUser(docId);
    if (!user) return;

    // Stratégie : Garder seulement les 10 derniers messages pour éviter l'accumulation
    let tracked = user.tracked_messages || [];
    if (!tracked.includes(messageId)) {
        tracked.push(messageId);
        // Limiter à 10 messages maximum (FIFO - First In First Out)
        if (tracked.length > 10) {
            tracked = tracked.slice(-10); // Garde les 10 derniers
        }
    }

    await supabase.from(COL_USERS).update({
        tracked_messages: tracked,
        last_menu_id: messageId
    }).eq('id', docId);

    _userCache.delete(docId);
}

async function getLastMenuId(docId) {
    const user = await getUser(docId);
    return user ? user.last_menu_id : null;
}

// --- Orders ---
async function createOrder(orderData) {
    // SÉCURITÉ : On s'assure que l'utilisateur est bien enregistré avant de créer la commande
    const tgId = orderData.user_id.replace('telegram_', '');
    try {
        await registerUser({
            id: tgId,
            username: orderData.username || 'inconnu',
            first_name: orderData.first_name || 'Inconnu',
            type: 'user'
        });
    } catch (e) {
        console.error("⚠️ registerUser failed during createOrder:", e.message);
        // Vérifie si l'utilisateur existe quand même (erreur de doublon OK)
        const existingUser = await getUser(`telegram_${tgId}`);
        if (!existingUser) {
            console.error(`❌ Cannot create order: user ${tgId} doesn't exist and registration failed`);
            return { order: null, error: new Error("Utilisateur introuvable") };
        }
    }

    const id = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const { data, error } = await supabase.from(COL_ORDERS).insert([{
        id: id,
        ...orderData,
        scheduled_at: orderData.scheduled_at || null,
        status: 'pending',
        created_at: ts(),
        notif_1h_sent: false,
        notif_30m_sent: false
    }]).select();

    if (error) {
        console.error("Error createOrder", error);
        return { order: null, error };
    }

    await incrementStat('total_orders');
    return { order: data[0], error: null };
}

async function getUpcomingPlannedOrders() {
    // On cherche les commandes qui ne sont pas encore livrées/annulées et qui ont un horaire prévu
    const { data, error } = await supabase.from(COL_ORDERS)
        .select('*')
        .not('status', 'in', '("delivered","cancelled")')
        .not('scheduled_at', 'is', null);

    if (error) return [];
    return data;
}

async function markNotifSent(orderId, type) {
    const field = type === '1h' ? 'notif_1h_sent' : 'notif_30m_sent';
    await supabase.from(COL_ORDERS).update({ [field]: true }).eq('id', orderId);
}

async function updateOrderStatus(orderId, status, extraData = {}) {
    if (status === 'delivered') {
        extraData.delivered_at = ts();
        const order = await getOrder(orderId);
        if (order && !order.points_awarded) {
            const user = await getUser(order.user_id);
            if (user) {
                const price = parseFloat(order.total_price) || 0;
                const settings = await getAppSettings();
                const pointsRatio = settings.points_ratio || 1;
                const refBonus = settings.ref_bonus || 5;

                const pointsToAdd = Math.floor(price * pointsRatio);
                const isFirstOrder = user.order_count === 0;

                if (isFirstOrder && user.referred_by) {
                    await updateUserWallet(user.id, (user.wallet_balance || 0) + refBonus);
                    const referrer = await getUser(user.referred_by);
                    if (referrer) {
                        await updateUserWallet(referrer.id, (referrer.wallet_balance || 0) + refBonus);
                    }
                }

                await updateUserPoints(user.id, (user.points || 0) + pointsToAdd);
                const newOrderCount = (user.order_count || 0) + 1;
                await supabase.from(COL_USERS).update({ order_count: newOrderCount }).eq('id', user.id);

                // --- Système de Bonus Fidélité ---
                const thresholds = (settings.fidelity_bonus_thresholds || "5,9,10").split(',').map(t => parseInt(t.trim())).filter(t => !isNaN(t));
                const bonusAmount = parseFloat(settings.fidelity_bonus_amount) || 10;

                if (thresholds.includes(newOrderCount)) {
                    await updateUserWallet(user.id, (user.wallet_balance || 0) + bonusAmount);
                    // On pourrait aussi notifier le client via bot.telegram.sendMessage ici si on avait accès à bot
                    console.log(`🎁 Bonus fidélité de ${bonusAmount}€ accordé à ${user.id} pour sa ${newOrderCount}ème commande.`);
                }

                _userCache.delete(user.id);
                extraData.points_awarded = true;
            }
        }
    }
    await supabase.from(COL_ORDERS).update({ status, ...extraData, updated_at: ts() }).eq('id', orderId);

    // Notification Admin sur chaque changement
    try {
        const settings = await getAppSettings();
        if (settings.admin_telegram_id) {
            const { getBotInstance } = require('../server');
            const bot = getBotInstance();
            if (bot) {
                const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim().replace('telegram_', ''));
                const label = (status === 'delivered' ? settings.status_delivered_label :
                    (status === 'pending' ? settings.status_pending_label :
                        (status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label))) || status.toUpperCase();
                const icon = (status === 'delivered' ? settings.ui_icon_success :
                    (status === 'pending' ? settings.ui_icon_pending :
                        (status === 'taken' ? (settings.ui_icon_taken || '🚚') : settings.ui_icon_error))) || '🔔';

                const alertMsg = `${icon} <b>MISE À JOUR COMMANDE</b>\n\n🆔 ID : <code>#${orderId.substring(0, 5)}</code>\n🔄 Statut : <b>${label}</b>`;
                for (const adminId of adminIds) {
                    bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML' }).catch(() => { });
                }
            }
        }
    } catch (e) { }

    if (status === 'delivered') {
        const order = await getOrder(orderId);
        if (order) {
            const price = parseFloat(order.total_price) || 0;
            await addToStat('total_ca', price);
        }
    }
}

async function getOrdersByUser(userId) {
    const { data } = await supabase.from(COL_ORDERS).select('*').eq('user_id', userId).order('created_at', { ascending: false });
    return data || [];
}

async function assignOrderLivreur(orderId, livreurId, livreurName) {
    const update = {
        livreur_id: livreurId || null,
        livreur_name: livreurName || null,
        status: livreurId ? 'taken' : 'pending',
        updated_at: ts()
    };
    await supabase.from(COL_ORDERS).update(update).eq('id', orderId);

    // Notifier Admin
    try {
        const settings = await getAppSettings();
        if (settings.admin_telegram_id && livreurId) {
            const { getBotInstance } = require('../server');
            const bot = getBotInstance();
            if (bot) {
                const adminIds = String(settings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim().replace('telegram_', ''));
                const alertMsg = `🚚 <b>AFFECTATION</b>\n\n🆔 #<code>${orderId.substring(0, 5)}</code>\n👤 Livreur : <b>${livreurName}</b>`;
                for (const adminId of adminIds) {
                    bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML' }).catch(() => { });
                }
            }
        }
    } catch (e) { }
}

async function getClientActiveOrders(userId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('user_id', userId)
        .in('status', ['pending', 'taken'])
        .order('created_at', { ascending: false });
    return data || [];
}

async function logHelpRequest(orderId, type, message) {
    try {
        const order = await getOrder(orderId);
        if (!order) return;
        const requests = Array.isArray(order.help_requests) ? order.help_requests : [];
        requests.push({ type, message, timestamp: ts() });
        const { error } = await supabase.from(COL_ORDERS).update({ help_requests: requests }).eq('id', orderId);
        if (error) console.error("❌ SQL logHelpRequest failed:", error.message);
    } catch (e) {
        console.error("❌ logHelpRequest error:", e.message);
    }
}

async function saveClientReply(orderId, reply) {
    await supabase.from(COL_ORDERS).update({ client_reply: reply }).eq('id', orderId);
}

async function incrementChatCount(orderId) {
    try {
        const order = await getOrder(orderId);
        if (!order) return 0;

        // Sécurité : si la colonne est absente ou NaN, on force à 0
        let currentCount = parseInt(order.chat_count);
        if (isNaN(currentCount)) currentCount = 0;

        const newCount = currentCount + 1;
        const { error } = await supabase.from(COL_ORDERS).update({ chat_count: newCount }).eq('id', orderId);

        if (error) {
            console.error("❌ SQL incrementChatCount failed:", error.message);
            // Si erreur SQL (colonne manquante), on renvoie quand même un nombre pour ne pas bloquer le relayage
            return newCount;
        }
        return newCount;
    } catch (e) {
        console.error("❌ incrementChatCount error:", e.message);
        return 1;
    }
}

async function saveFeedback(orderId, rating, text) {
    await supabase.from(COL_ORDERS).update({
        feedback_rating: rating,
        feedback_text: text,
        updated_at: ts()
    }).eq('id', orderId);
}

async function setPendingFeedback(userId, orderId, rate) {
    const user = await getUser(userId);
    if (!user) return;
    let meta = user.data || {};
    meta.pending_feedback = { orderId, rate };
    await supabase.from(COL_USERS).update({ data: meta, updated_at: ts() }).eq('id', userId);
    _userCache.delete(userId);
}

async function getAndClearPendingFeedback(userId) {
    const user = await getUser(userId);
    if (!user || !user.data || !user.data.pending_feedback) return null;
    const feedback = user.data.pending_feedback;

    let meta = user.data;
    delete meta.pending_feedback;
    await supabase.from(COL_USERS).update({ data: meta, updated_at: ts() }).eq('id', userId);
    _userCache.delete(userId);
    return feedback;
}

async function getOrder(orderId) {
    const { data } = await supabase.from(COL_ORDERS).select('*').eq('id', orderId).limit(1);
    return data && data.length > 0 ? data[0] : null;
}

async function getAvailableOrders(city = null) {
    let q = supabase.from(COL_ORDERS).select('*').eq('status', 'pending');
    if (city && city !== 'all' && city !== 'non défini') {
        q = q.eq('city', city.toLowerCase());
    }
    const { data } = await q.order('created_at', { ascending: false });
    return data || [];
}

async function getAllOrders(limit = 50) {
    const { data } = await supabase.from(COL_ORDERS).select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function getLivreurHistory(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'delivered')
        .order('created_at', { ascending: false });
    return data || [];
}

async function getLivreurOrders(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'taken');
    return data || [];
}

async function getUser(docId) {
    if (_userCache.has(docId)) {
        const cached = _userCache.get(docId);
        if (Date.now() < cached.expire) {
            return decryptUser(cached.data);
        }
    }

    const { data } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
    const rawData = data && data.length > 0 ? data[0] : null;

    if (rawData) {
        _userCache.set(docId, { data: rawData, expire: Date.now() + 300000 }); // 5 minutes cache
        return decryptUser(rawData);
    }
    return null;
}

async function getUserCount(platform = null) {
    let q = supabase.from(COL_USERS).select('*', { count: 'exact', head: true });
    if (platform) q = q.eq('platform', platform);
    const { count } = await q;
    return count || 0;
}
async function getActiveUserCount(platform = null) {
    let q = supabase.from(COL_USERS).select('*', { count: 'exact', head: true }).eq('is_blocked', false).eq('is_active', true);
    if (platform) q = q.eq('platform', platform);
    const { count } = await q;
    return count || 0;
}
async function getRecentUsers(limit = 20) {
    const { data } = await supabase.from(COL_USERS).select('*').order('last_active', { ascending: false }).limit(limit);
    return (data || []).map(decryptUser);
}
async function searchUsers(query) {
    // Exact match by ID first (snappy)
    if (query && (query.startsWith('telegram_') || !isNaN(query))) {
        const idToSearch = query.startsWith('telegram_') ? query : `telegram_${query}`;
        const { data: exact } = await supabase.from(COL_USERS).select('*').or(`id.eq.${idToSearch},platform_id.eq.${query}`).limit(5);
        if (exact && exact.length > 0) return exact.map(decryptUser);
    }

    // Otherwise fetch a larger batch and filter in memory (for encrypted names)
    const { data } = await supabase.from(COL_USERS).select('*').order('last_active', { ascending: false }).limit(1000);
    const decrypted = (data || []).map(decryptUser);

    if (!query) return decrypted.slice(0, 50);

    const q = query.toLowerCase().replace('@', '');
    return decrypted.filter(u => {
        const uid = String(u.id || '').toLowerCase();
        const uname = String(u.username || '').toLowerCase();
        const fname = String(u.first_name || '').toLowerCase();
        const pid = String(u.platform_id || '').toLowerCase();

        return uid.includes(q) || uname.includes(q) || fname.includes(q) || pid.includes(q);
    }).slice(0, 50);
}

async function searchLivreurs(query) {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true).limit(200);
    const decrypted = (data || []).map(decryptUser);

    if (!query) return decrypted.slice(0, 50);

    const q = query.toLowerCase().replace('@', '');
    return decrypted.filter(u => {
        const uid = String(u.id || '').toLowerCase();
        const uname = String(u.username || '').toLowerCase();
        const fname = String(u.first_name || '').toLowerCase();
        const pid = String(u.platform_id || '').toLowerCase();

        return uid.includes(q) || uname.includes(q) || fname.includes(q) || pid.includes(q);
    }).slice(0, 50);
}

async function getDetailedLivreurActivity(livreurId) {
    if (!livreurId) return [];
    // Ensure format matches livreur_id in orders (e.g. telegram_123)
    const docId = (livreurId.includes('_') || livreurId.startsWith('t_')) ? livreurId : `telegram_${livreurId}`;

    // We try both formats just in case some orders have the raw ID
    const rawId = livreurId.replace('telegram_', '');

    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .or(`livreur_id.eq.${docId},livreur_id.eq.${rawId},livreur_id.eq.${livreurId}`)
        .order('created_at', { ascending: false })
        .limit(100);

    return data || [];
}

function generateReferralCode(platform, platformId) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return `ref_${platform}_${platformId}_${code}`;
}

async function getReferralLeaderboard(limit = 10) {
    const { data } = await supabase.from(COL_USERS).select('*').gt('referral_count', 0).order('referral_count', { ascending: false }).limit(limit);
    return (data || []).map(decryptUser);
}

// --- Stats ---
async function incrementStat(name) {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    const globalStats = data && data.length > 0 ? data[0] : { id: 'global' };
    const val = (globalStats[name] || 0) + 1;
    await supabase.from(COL_STATS).upsert({ ...globalStats, [name]: incr(val), id: 'global' });
}

async function addToStat(name, amount) {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    const globalStats = data && data.length > 0 ? data[0] : { id: 'global' };
    const val = (parseFloat(globalStats[name]) || 0) + parseFloat(amount);
    await supabase.from(COL_STATS).upsert({ ...globalStats, [name]: val, id: 'global' });
}

async function incrementDailyStat(name) {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from(COL_DAILY_STATS).select('*').eq('id', `daily_${today}`).limit(1);
    const daily = data && data.length > 0 ? data[0] : { id: `daily_${today}`, date: today };
    const val = (daily[name] || 0) + 1;
    await supabase.from(COL_DAILY_STATS).upsert({ ...daily, [name]: val, id: `daily_${today}`, date: today });
}

async function getGlobalStats() {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    return data && data.length > 0 ? data[0] : {};
}

async function getDailyStats(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const { data } = await supabase.from(COL_DAILY_STATS)
        .select('*')
        .gte('date', cutoff.toISOString().split('T')[0])
        .order('date', { ascending: true });
    return data || [];
}

async function getStatsOverview() {
    const now = Date.now();
    if (_statsCache.overview && (now - _statsCache.lastOverview < _statsCache.ttl)) {
        return _statsCache.overview;
    }

    const total = await getUserCount();
    const active = await getActiveUserCount();
    const stats = await getGlobalStats();
    const { data: bcSnap } = await supabase.from(COL_BROADCASTS).select('id, created_at, success, failed, message').order('created_at', { ascending: false }).limit(5);

    // Optimized count for active drivers (direct query, no memory decryption needed)
    const { count: activeLivreurs } = await supabase.from(COL_USERS)
        .select('*', { count: 'exact', head: true })
        .eq('is_livreur', true)
        .eq('is_available', true);

    const { count: totalLivreurs } = await supabase.from(COL_USERS)
        .select('*', { count: 'exact', head: true })
        .eq('is_livreur', true);

    // Get CA from Sum of delivered orders (more reliable than just global_stats)
    const { data: caData } = await supabase.from(COL_ORDERS).select('total_price').eq('status', 'delivered');
    const calculatedCA = (caData || []).reduce((acc, curr) => acc + (parseFloat(curr.total_price) || 0), 0);

    const totalCA = calculatedCA || parseFloat(stats.total_ca || stats.global?.total_ca || 0);

    // Get total count of all orders separately if needed, or just delivered
    const { count: totalOrdersCount } = await supabase.from(COL_ORDERS).select('*', { count: 'exact', head: true });

    const result = {
        totalUsers: total,
        activeUsers: active,
        totalStats: stats,
        totalOrders: totalOrdersCount || 0,
        totalCA: totalCA.toFixed(2),
        totalLivreurs: totalLivreurs || 0,
        activeLivreurs: activeLivreurs,
        recentBroadcasts: bcSnap || []
    };

    _statsCache.overview = result;
    _statsCache.lastOverview = now;
    return result;
}

async function getOrderAnalytics() {
    const now = Date.now();
    if (_statsCache.analytics && (now - _statsCache.lastAnalytics < _statsCache.ttl)) {
        return _statsCache.analytics;
    }

    // Limit to last 1000 orders to keep it snappy.
    const { data: ordersSnap } = await supabase.from(COL_ORDERS)
        .select('id, status, total_price, created_at, delivered_at, user_id, first_name, username, city, livreur_id, livreur_name, product_name, quantity')
        .order('created_at', { ascending: false })
        .limit(1000);

    const analytics = {
        totalCA: 0,
        totalOrders: 0,
        avgDeliveryTime: 0,
        byHour: {}, byDay: {}, byWeek: {}, byMonth: {}, byYear: {}, byCity: {}, byDriver: {}, byUser: {}, byProduct: {},
        rawDelivered: []
    };

    let totalDeliveryMinutes = 0;
    let deliveryCount = 0;

    (ordersSnap || []).forEach(order => {
        if (order.status !== 'delivered') return;

        const price = parseFloat(order.total_price) || 0;
        analytics.totalCA += price;
        analytics.totalOrders++;

        let deliveryMinutes = null;
        if (order.created_at && order.delivered_at) {
            const createdMs = new Date(order.created_at).getTime();
            const deliveredMs = new Date(order.delivered_at).getTime();
            deliveryMinutes = Math.round((deliveredMs - createdMs) / 60000);
            if (deliveryMinutes > 0 && deliveryMinutes < 1440) {
                totalDeliveryMinutes += deliveryMinutes;
                deliveryCount++;
            }
        }

        const clientId = order.user_id || 'unknown';
        const clientName = order.first_name || order.username || 'Client Inconnu';
        if (!analytics.byUser[clientName]) {
            analytics.byUser[clientName] = { count: 0, ca: 0 };
        }
        analytics.byUser[clientName].count++;
        analytics.byUser[clientName].ca += price;

        const driverName = order.livreur_name || 'Inconnu';
        if (!analytics.byDriver[driverName]) {
            analytics.byDriver[driverName] = { count: 0, ca: 0 };
        }
        analytics.byDriver[driverName].count++;
        analytics.byDriver[driverName].ca += price;

        const productName = order.product_name || 'Inconnu';
        if (!analytics.byProduct[productName]) {
            analytics.byProduct[productName] = { qty: 0, ca: 0 };
        }
        analytics.byProduct[productName].qty += (parseInt(order.quantity) || 1);
        analytics.byProduct[productName].ca += price;

        if (order.created_at) {
            const date = new Date(order.created_at);
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

        analytics.rawDelivered.push({
            id: order.id,
            date: order.created_at ? new Date(order.created_at).toLocaleString('fr-FR') : '?',
            delivered_date: order.delivered_at ? new Date(order.delivered_at).toLocaleString('fr-FR') : null,
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

    _statsCache.analytics = analytics;
    _statsCache.lastAnalytics = now;
    return analytics;
}

async function getAvailableLivreurs() {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
    return (data || []).map(d => decryptUser(d)).filter(l => l.is_available);
}

async function getAllLivreurs() {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
    return (data || []).map(d => decryptUser(d));
}

// --- Settings ---
const SETTINGS_DEFAULTS = {
    bot_name: 'La Frappe IDF',
    dashboard_title: 'La Frappe IDF - Admin',
    welcome_message: 'Bienvenue ! Vous faites partie de la famille.',
    admin_password: process.env.ADMIN_PASSWORD || 'lafrappe2024',
    admin_telegram_id: String(process.env.ADMIN_TELEGRAM_ID || ''),
    ui_icon_catalog: '👟',
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
    ui_icon_broadcast: '📣',
    ui_icon_logout: '🚪',
    ui_icon_taken: '🚚',
    ui_icon_help: '❓',
    label_catalog: 'Catalogue Produits',
    label_my_orders: 'Mes Commandes',
    label_contact: 'Contact Admin',
    label_channel: 'Lien Canal Telegram',
    label_welcome: 'Message d\'accueil',
    label_profile: 'Mon Profil / Parrainage',
    label_admin_bot: 'Gestion Bot',
    label_admin_web: 'Dashboard Web',
    label_livreur: 'Espace Livreur',
    label_livreur_space: 'Espace Livreur',
    label_help: 'Aide & Support',
    status_pending_label: 'Attente Validation',
    status_taken_label: 'En cours de livraison',
    status_delivered_label: 'Livré ✅',
    status_cancelled_label: 'Annulé ❌',
    msg_auto_timer: '🔥 <b>Le catalogue est à jour !</b>\nProfitez de nos nouveaux produits et de nos promos en cours. 🚀',
    msg_choose_qty: 'Choisissez la quantité souhaitée :',
    msg_search_livreur: '⏳ Recherche d\'un livreur en cours...',
    msg_order_success: '✅ <b>Commande enregistrée !</b>',
    msg_help_intro: 'Besoin d\'aide ? Choisissez une option ci-dessous :',
    points_exchange: 100,
    points_ratio: 1,
    ref_bonus: 5,
    points_credit_value: 10,
    fidelity_wallet_max_pct: 50,
    fidelity_min_spend: 50,
    fidelity_bonus_thresholds: '5,10,15,20',
    fidelity_bonus_amount: 10,
    list_admins: [],
    dashboard_url: process.env.DASHBOARD_URL || '',
    private_contact_url: 'https://t.me/lafrappex',
    channel_url: 'https://t.me/lafrappe_canal',
    bot_description: '',
    bot_short_description: '',
    payment_modes: '💵 Espèces',
    maintenance_mode: false,
    maintenance_message: '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l\'admin : @lafrappex',
    maintenance_contact: 'https://t.me/lafrappex'
};

let _settingsCache = null;
let _settingsExpire = 0;

async function getAppSettings() {
    if (_settingsCache && Date.now() < _settingsExpire) {
        return _settingsCache;
    }

    const { data } = await supabase.from(COL_SETTINGS).select('*').eq('id', 'config').limit(1);
    let settings = { ...SETTINGS_DEFAULTS };

    if (!data || data.length === 0) {
        await supabase.from(COL_SETTINGS).insert([{ id: 'config', ...SETTINGS_DEFAULTS }]);
    } else {
        settings = { ...SETTINGS_DEFAULTS, ...data[0] };
    }

    // Auto-réparation légère (évite les valeurs "test" collatérales)
    const repairs = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        const val = settings[key];
        // On ne répare que SI c'est exactement "test" (pas si ça contient "test" comme "testateur")
        if (typeof val === 'string' && val.toLowerCase() === 'test') {
            settings[key] = SETTINGS_DEFAULTS[key];
            repairs[key] = SETTINGS_DEFAULTS[key];
        }
        // Pour les icônes vide ou non-emoji (fallback securisé)
        if (key.startsWith('ui_icon_') && (!val || val.length > 5 || /^[a-zA-Z0-9]+$/.test(val))) {
            settings[key] = SETTINGS_DEFAULTS[key];
            repairs[key] = SETTINGS_DEFAULTS[key];
        }
    }

    // Synchronisation label_livreur
    if (!settings.label_livreur || settings.label_livreur === '') {
        settings.label_livreur = settings.label_livreur_space || SETTINGS_DEFAULTS.label_livreur;
    }

    if (Object.keys(repairs).length > 0) {
        console.log(`🔧 [DB] Auto-réparation de ${Object.keys(repairs).length} champs :`, Object.keys(repairs).join(', '));
        supabase.from(COL_SETTINGS).update(repairs).eq('id', 'config').then(() => { }).catch(() => { });
    }


    _settingsCache = settings;
    _settingsExpire = Date.now() + 10000; // Cache valid for 10 seconds
    return settings;
}

async function updateAppSettings(settings) {
    const { error } = await supabase.from(COL_SETTINGS).update(settings).eq('id', 'config');
    if (error) {
        console.error('❌ Error updating settings:', error);
        throw error;
    }
    _settingsCache = null; // Invalidate cache
}

// --- Products ---
let _productsCache = null;
let _productsExpire = 0;

async function getProducts() {
    if (_productsCache && Date.now() < _productsExpire) {
        return _productsCache;
    }
    const { data } = await supabase.from(COL_PRODUCTS).select('*');
    _productsCache = data || [];
    _productsExpire = Date.now() + 15000; // Cache valid for 15 seconds
    return _productsCache;
}

async function saveProduct(data) {
    const id = data.id || `${Date.now()}`;
    delete data.id;
    const { error } = await supabase.from(COL_PRODUCTS).upsert({ id, ...data, created_at: ts() });
    if (error) {
        console.error("Error saveProduct", error);
        throw new Error(`Erreur Supabase: ${error.message}`);
    }
    _productsCache = null; // Invalidate cache
    return id;
}

async function deleteProduct(id) {
    await supabase.from(COL_PRODUCTS).delete().eq('id', id);
    _productsCache = null; // Invalidate cache
}

// --- Broadcasts ---
async function saveBroadcast(data) {
    const id = `${Date.now()}`;
    await supabase.from(COL_BROADCASTS).insert([{ id, ...data, created_at: ts() }]);
    return id;
}
async function updateBroadcast(broadcastId, data) {
    await supabase.from(COL_BROADCASTS).update(data).eq('id', broadcastId);
}
async function deleteBroadcast(id) {
    await supabase.from(COL_BROADCASTS).delete().eq('id', id);
}

async function getBroadcastHistory(limit = 50) {
    const { data } = await supabase.from(COL_BROADCASTS).select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function nukeDatabase() {
    const collections = [COL_REVIEWS, COL_PRODUCTS, COL_ORDERS, COL_USERS, COL_STATS, COL_BROADCASTS, COL_DAILY_STATS, COL_REFERRALS, COL_SETTINGS];
    for (const col of collections) {
        await supabase.from(col).delete().neq('id', 'neverMatchThisString12345'); // Deletes all rows where ID != "..."
    }
}

// --- Reviews ---
async function saveReview(reviewData) {
    const id = reviewData.id || `rev_${Date.now()}`;
    const { error } = await supabase.from(COL_REVIEWS).upsert([{ id, ...reviewData, created_at: ts() }]);
    if (error) throw error;
    return id;
}

async function getReviews(limit = 50) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function getPublicReviews(limit = 20) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').eq('is_public', true).order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function deleteReview(id) {
    await supabase.from(COL_REVIEWS).delete().eq('id', id);
}

async function uploadMediaFromUrl(url, fileName) {
    if (!url) return null;
    try {
        const axios = require('axios');
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });

        const buffer = Buffer.from(response.data);
        const { error } = await supabase.storage.from('uploads').upload(fileName, buffer, {
            contentType: response.headers['content-type'] || 'image/jpeg',
            upsert: true
        });

        if (error) throw error;
        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
        return publicUrlData.publicUrl;
    } catch (e) {
        console.error("❌ uploadMediaFromUrl failed:", e.message);
        throw e;
    }
}

async function markUserUnblocked(userId) {
    await supabase.from(COL_USERS).update({ is_blocked: false }).eq('id', userId);
}

module.exports = {
    supabase, COL_USERS, COL_PRODUCTS, COL_ORDERS, COL_SETTINGS, COL_BROADCASTS, COL_REFERRALS,
    incr, ts, makeDocId, decryptUser,
    registerUser, getAllActiveUsers, getAllUsersForBroadcast, markUserBlocked, markUserUnblocked, deleteUser, getUser, updateUserWallet, updateUserPoints,
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers, searchLivreurs,
    generateReferralCode, getReferralLeaderboard, incrementOrderCount,
    setLivreurStatus, updateLivreurPosition, getActiveLivreursCount,
    createOrder, updateOrderStatus, assignOrderLivreur, getOrder, getAvailableOrders, getAllOrders,
    saveBroadcast, updateBroadcast, deleteBroadcast, getBroadcastHistory, incrementStat, incrementDailyStat,
    getGlobalStats, getDailyStats, getStatsOverview, getAppSettings, updateAppSettings, getClientActiveOrders,
    getProducts, saveProduct, deleteProduct, setLivreurAvailability,
    getAvailableLivreurs, getAllLivreurs, getOrderAnalytics, saveUserLocation, addMessageToTrack, getLastMenuId, getLivreurOrders, getLivreurHistory, getOrdersByUser, getDetailedLivreurActivity, saveFeedback, setPendingFeedback, getAndClearPendingFeedback, nukeDatabase,
    saveReview, getReviews, getPublicReviews, deleteReview, uploadMediaFromUrl,
    incrementChatCount, saveClientReply, logHelpRequest,
    getUpcomingPlannedOrders, markNotifSent, registerUser, addToStat,
    _userCache
};
