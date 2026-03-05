const { getAllActiveUsers, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');
const fs = require('fs');
const path = require('path');

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_la_frappe.log'), line);
    } catch (e) { }
    console.log(msg);
}

// Configuration des délais
const MEDIA_BATCH_SIZE = 5;
const TEXT_BATCH_SIZE = 25;
const DELAY_BETWEEN_BATCHES_MS = 1200;

let _bot = null;
function setBroadcastBot(bot) { _bot = bot; }

async function broadcastMessage(platform, message, options = {}) {
    const { mediaFiles = [], mediaUrls: existingUrls = [] } = options;
    debugLog(`[BC-START] Plateforme: ${platform}, Médias: ${mediaFiles.length}, URLs: ${existingUrls.length}, Message: "${(message || '').substring(0, 30)}..."`);

    // Récupérer toutes les cibles (users + groups)
    const targets = await getAllActiveUsers(platform === 'all' ? null : 'telegram');
    const totalTargets = targets.length;
    debugLog(`[BC-TARGETS] ${totalTargets} cibles trouvées.`);

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // 1. Upload des nouveaux médias vers Supabase Storage
    const unifiedMediaList = [...existingUrls]; // Start with existing if any
    const { supabase } = require('../config/supabase');
    for (let f of mediaFiles) {
        try {
            const fileName = `bc-${Date.now()}-${Math.round(Math.random() * 1E9)}-${f.name.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
            const { error } = await supabase.storage.from('uploads').upload(fileName, f.data, {
                contentType: f.mimetype,
                upsert: true
            });
            if (!error) {
                const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(fileName);
                unifiedMediaList.push({ url: publicData.publicUrl, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            } else {
                debugLog(`[BC-UPLOAD-WARN] Supabase error: ${error.message}. Fallback to buffer.`);
                unifiedMediaList.push({ source: f.data, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            }
        } catch (e) {
            debugLog(`[BC-UPLOAD-ERR] ${e.message}`);
            unifiedMediaList.push({ source: f.data, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
        }
    }

    // 2. Init log en DB
    const broadcastId = await saveBroadcast({
        message: message ? message : `[Médias: ${unifiedMediaList.length}]`,
        media_urls: unifiedMediaList.filter(m => m.url), // Only store URLs in DB
        total_target: totalTargets,
        target_platform: platform,
        status: 'in_progress',
        success: 0, failed: 0, blocked: 0
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const currentBatchSize = unifiedMediaList.length > 0 ? MEDIA_BATCH_SIZE : TEXT_BATCH_SIZE;

    for (let i = 0; i < targets.length; i += currentBatchSize) {
        const batch = targets.slice(i, i + currentBatchSize);
        debugLog(`[BC-BATCH] Lot ${Math.floor(i / currentBatchSize) + 1} (${batch.length} cibles)`);

        const results = await Promise.allSettled(
            batch.map((user) => sendToUser(user, message, unifiedMediaList))
        );

        for (const [idx, result] of results.entries()) {
            if (result.status === 'fulfilled') {
                const { success, blocked, error } = result.value;
                if (success) {
                    successCount++;
                } else {
                    if (blocked) blockedCount++;
                    else failedCount++;
                    debugLog(`[BC-FAILED] ${batch[idx].platform_id}: ${error}`);
                }
            } else {
                failedCount++;
                debugLog(`[BC-FATAL] ${batch[idx].platform_id}: ${result.reason}`);
            }
        }

        if (i + currentBatchSize < targets.length) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
        }
    }

    // Finaliser log en DB
    await updateBroadcast(broadcastId, {
        status: 'completed',
        success: successCount,
        failed: failedCount,
        blocked: blockedCount,
        completed_at: new Date().toISOString()
    });

    debugLog(`[BC-END] Terminé. Succès: ${successCount}, Échecs: ${failedCount}, Bloqués: ${blockedCount}`);
    return { success: successCount, failed: failedCount, blocked: blockedCount, total: totalTargets, broadcastId };
}

async function sendToUser(user, message, unifiedMediaList = []) {
    if (!_bot) {
        debugLog("[BC-ERROR] Bot non initialisé dans le service broadcast");
        return { success: false, error: "Bot non prêt" };
    }

    const chatId = user.platform_id;
    // Telegram caption limit is 1024 chars.
    const caption = message ? (message.length > 1020 ? message.substring(0, 1017) + '...' : message) : '';

    try {
        if (unifiedMediaList.length > 1) {
            const mediaGroup = unifiedMediaList.slice(0, 10).map((m, i) => ({
                type: m.type,
                media: m.url || m.source,
                ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
            }));
            debugLog(`[BC-SEND] MediaGroup (${mediaGroup.length}) CDN Stream -> ${chatId}`);
            await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
        } else if (unifiedMediaList.length === 1) {
            const m = unifiedMediaList[0];
            debugLog(`[BC-SEND] Single ${m.type.toUpperCase()} CDN Stream -> ${chatId}`);
            if (m.type === 'video') {
                await _bot.telegram.sendVideo(chatId, m.url || m.source, { caption: caption, parse_mode: 'HTML' });
            } else {
                await _bot.telegram.sendPhoto(chatId, m.url || m.source, { caption: caption, parse_mode: 'HTML' });
            }
        } else {
            // Texte uniquement
            debugLog(`[BC-SEND] Texte -> ${chatId}`);
            await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
        return { success: true };
    } catch (error) {
        const desc = error.description || error.message || "Erreur inconnue";
        const errorName = error.name || "Error";
        debugLog(`[BC-ERROR] Cible ${chatId}: [${errorName}] ${desc}`);

        if (error.code === 403 || desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked')) {
            if (user.doc_id) await markUserBlocked(user.doc_id).catch(() => { });
            return { success: false, blocked: true, error: desc };
        }
        return { success: false, error: desc };
    }
}

module.exports = { broadcastMessage, setBroadcastBot };
