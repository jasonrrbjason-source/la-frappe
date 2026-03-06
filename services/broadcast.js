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
    let bType = null;
    if (platform === 'users') bType = 'user';
    else if (platform === 'groups') bType = 'group';
    else if (platform === 'livreurs') bType = 'livreurs';

    const targets = await getAllActiveUsers('telegram', bType);
    const totalTargets = targets.length;
    debugLog(`[BC-TARGETS] ${totalTargets} cibles trouvées (Platform: ${platform}, InternalType: ${bType}).`);

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // 1. Upload des nouveaux médias vers Supabase Storage
    const normalizedExistingUrls = existingUrls.map(u => typeof u === 'string' ? { url: u, type: (u.match(/\.(mp4|mov|avi|wmv)$/) ? 'video' : 'photo') } : u);
    const unifiedMediaList = [...normalizedExistingUrls];
    const { supabase } = require('../config/supabase');
    for (let f of mediaFiles) {
        try {
            const extension = f.mimetype.includes('video') ? 'mp4' : (f.mimetype.includes('png') ? 'png' : 'jpg');
            const fileName = `bc-${Date.now()}-${Math.round(Math.random() * 1E9)}-${f.name.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
            const finalPath = fileName.match(/\.[a-zA-Z0-9]+$/) ? fileName : `${fileName}.${extension}`;

            let fileBuffer = f.data;
            if (!fileBuffer && f.tempFilePath) {
                fileBuffer = fs.readFileSync(f.tempFilePath);
            }

            const { error } = await supabase.storage.from('uploads').upload(finalPath, fileBuffer, {
                contentType: f.mimetype,
                upsert: true
            });
            if (!error) {
                const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(finalPath);
                unifiedMediaList.push({ url: publicData.publicUrl, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            } else {
                debugLog(`[BC-UPLOAD-WARN] Supabase error: ${error.message}. Fallback to buffer.`);
                unifiedMediaList.push({ source: fileBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            }
        } catch (e) {
            debugLog(`[BC-UPLOAD-ERR] ${e.message}`);
            let fallbackBuffer = f.data;
            try { if (!fallbackBuffer && f.tempFilePath) fallbackBuffer = fs.readFileSync(f.tempFilePath); } catch (err) { }
            unifiedMediaList.push({ source: fallbackBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
        }
    }

    // 2. Init log en DB
    const mediaUrlsJson = JSON.stringify(unifiedMediaList.filter(m => m.url).map(m => m.url));
    const finalMessageStr = message ? message : `[Médias: ${unifiedMediaList.length}]`;
    const payloadMessage = `${finalMessageStr}|||MEDIA_URLS|||${mediaUrlsJson}`;

    const broadcastId = await saveBroadcast({
        message: payloadMessage,
        media_count: unifiedMediaList.length,
        total_target: totalTargets,
        target_platform: platform,
        status: 'in_progress',
        success: 0, failed: 0, blocked: 0
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const currentBatchSize = unifiedMediaList.length > 0 ? MEDIA_BATCH_SIZE : TEXT_BATCH_SIZE;

    let targetsToProcess = [...targets];

    // Seed Telegram file_ids by sending to the first user synchronously.
    // This allows subsequent batch sends to use file_ids (CDN pointers) instead of uploading massive buffers, avoiding memory and network crashes.
    if (unifiedMediaList.length > 0 && targetsToProcess.length > 0) {
        debugLog("[BC-SEED] Initializing file_id caching with first user...");
        let seederSuccess = false;
        while (targetsToProcess.length > 0 && !seederSuccess) {
            const seedUser = targetsToProcess.shift();
            const res = await sendToUser(seedUser, message, unifiedMediaList);
            if (res.success) {
                successCount++;
                seederSuccess = true;
                debugLog("[BC-SEED] Cached Telegram file_ids successfully.");
            } else {
                if (res.blocked) blockedCount++;
                else failedCount++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Now loop through remaining targets
    for (let i = 0; i < targetsToProcess.length; i += currentBatchSize) {
        const batch = targetsToProcess.slice(i, i + currentBatchSize);
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
    }).catch(e => debugLog(`[BC-LOG-ERR] ${e.message}`));

    debugLog(`[BC-END] Terminé. Succès: ${successCount}, Échecs: ${failedCount}, Bloqués: ${blockedCount}`);
    return { success: successCount, failed: failedCount, blocked: blockedCount, total: totalTargets, broadcastId };
}

async function sendToUser(user, message, unifiedMediaList = []) {
    if (!_bot) {
        debugLog("[BC-ERROR] Bot non initialisé dans le service broadcast");
        return { success: false, error: "Bot non prêt" };
    }

    const chatId = user.platform_id;
    const caption = message ? (message.length > 1020 ? message.substring(0, 1017) + '...' : message) : '';

    try {
        if (unifiedMediaList.length > 1) {
            const mediaGroup = unifiedMediaList.slice(0, 10).map((m, i) => {
                let mediaObj = m.file_id;
                if (!mediaObj) {
                    if (m.source) {
                        // Pass buffer correctly to Telegraf
                        mediaObj = { source: m.source, filename: m.filename || 'media.mp4' };
                    } else if (m.url) {
                        mediaObj = m.url;
                    }
                }
                return {
                    type: m.type,
                    media: mediaObj,
                    ...(m.type === 'video' ? { supports_streaming: true } : {}),
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });

            debugLog(`[BC-SEND] MediaGroup (${mediaGroup.length}) -> ${chatId}`);
            const msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup);

            // Cache file_ids & Tracking
            if (msgs && Array.isArray(msgs)) {
                const { addMessageToTrack } = require('./database');
                for (const msg of msgs) {
                    await addMessageToTrack(user.id || user.doc_id, msg.message_id).catch(() => { });
                }

                msgs.forEach((msg, i) => {
                    if (!unifiedMediaList[i].file_id) {
                        let fId = null;
                        if (msg.photo && msg.photo.length > 0) fId = msg.photo[msg.photo.length - 1].file_id;
                        else if (msg.video) fId = msg.video.file_id;
                        if (fId) unifiedMediaList[i].file_id = fId;
                    }
                });
            }
        } else if (unifiedMediaList.length === 1) {
            const mData = unifiedMediaList[0];
            let mediaObj = mData.file_id;
            if (!mediaObj) {
                if (mData.source) mediaObj = { source: mData.source, filename: mData.filename || 'media.mp4' };
                else if (mData.url) mediaObj = mData.url;
            }

            debugLog(`[BC-SEND] Single ${mData.type.toUpperCase()} -> ${chatId}`);
            let msg;
            if (mData.type === 'video') {
                msg = await _bot.telegram.sendVideo(chatId, mediaObj, {
                    caption: caption,
                    parse_mode: 'HTML',
                    supports_streaming: true
                });
                if (msg.video && !unifiedMediaList[0].file_id) unifiedMediaList[0].file_id = msg.video.file_id;
            } else {
                msg = await _bot.telegram.sendPhoto(chatId, mediaObj, { caption: caption, parse_mode: 'HTML' });
                if (msg.photo && !unifiedMediaList[0].file_id) unifiedMediaList[0].file_id = msg.photo[msg.photo.length - 1].file_id;
            }
            if (msg && user.id) {
                const { addMessageToTrack } = require('./database');
                await addMessageToTrack(user.id, msg.message_id).catch(() => { });
            }
        } else {
            // Texte uniquement
            debugLog(`[BC-SEND] Texte -> ${chatId}`);
            const msg = await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
            if (msg && user.id) {
                const { addMessageToTrack } = require('./database');
                await addMessageToTrack(user.id, msg.message_id).catch(() => { });
            }
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
