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
    const { mediaFiles = [] } = options;
    debugLog(`[BC-START] Plateforme: ${platform}, Médias: ${mediaFiles.length}, Message: "${(message || '').substring(0, 30)}..."`);

    // Récupérer toutes les cibles (users + groups)
    const targets = await getAllActiveUsers(platform === 'all' ? null : 'telegram');
    const totalTargets = targets.length;
    debugLog(`[BC-TARGETS] ${totalTargets} cibles trouvées.`);

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // Init log en DB
    const broadcastId = await saveBroadcast({
        message: message ? message.substring(0, 500) : `[Médias: ${mediaFiles.length}]`,
        total_target: totalTargets,
        target_platform: platform,
        status: 'in_progress',
        success: 0, failed: 0, blocked: 0
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const currentBatchSize = mediaFiles.length > 0 ? MEDIA_BATCH_SIZE : TEXT_BATCH_SIZE;

    for (let i = 0; i < targets.length; i += currentBatchSize) {
        const batch = targets.slice(i, i + currentBatchSize);
        debugLog(`[BC-BATCH] Lot ${Math.floor(i / currentBatchSize) + 1} (${batch.length} cibles)`);

        const results = await Promise.allSettled(
            batch.map((user) => sendToUser(user, message, { mediaFiles }))
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

async function sendToUser(user, message, { mediaFiles = [] }) {
    if (!_bot) {
        debugLog("[BC-ERROR] Bot non initialisé dans le service broadcast");
        return { success: false, error: "Bot non prêt" };
    }

    const chatId = user.platform_id;
    // Telegram caption limit is 1024 chars.
    const caption = message ? (message.length > 1020 ? message.substring(0, 1017) + '...' : message) : '';

    try {
        if (mediaFiles.length > 1) {
            // Groupe de médias (max 10)
            const mediaGroup = mediaFiles.slice(0, 10).map((f, i) => {
                const isVideo = (f.mimetype && f.mimetype.includes('video')) || (f.name && f.name.match(/\.(mp4|webm|mov|m4v|avi|mkv)$/i));
                return {
                    type: isVideo ? 'video' : 'photo',
                    media: { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') },
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });
            debugLog(`[BC-SEND] MediaGroup (${mediaGroup.length}) -> ${chatId}`);
            await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
        } else if (mediaFiles.length === 1) {
            // Un seul média
            const f = mediaFiles[0];
            const isVideo = (f.mimetype && f.mimetype.includes('video')) || (f.name && f.name.match(/\.(mp4|webm|mov|m4v|avi|mkv)$/i));
            const source = { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') };

            debugLog(`[BC-SEND] Single ${isVideo ? 'VIDEO' : 'PHOTO'} -> ${chatId} (${f.data.length} octets) Type: ${f.mimetype}`);
            if (isVideo) {
                await _bot.telegram.sendVideo(chatId, source, { caption: caption, parse_mode: 'HTML' });
            } else {
                await _bot.telegram.sendPhoto(chatId, source, { caption: caption, parse_mode: 'HTML' });
            }
        } else {
            // Texte uniquement
            debugLog(`[BC-SEND] Texte -> ${chatId}`);
            await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
        return { success: true };
    } catch (error) {
        const desc = error.description || error.message;
        debugLog(`[BC-ERROR] Cible ${chatId}: ${desc}`);

        if (error.code === 403 || desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked')) {
            await markUserBlocked(user.doc_id).catch(() => { });
            return { success: false, blocked: true, error: desc };
        }
        return { success: false, error: desc };
    }
}

module.exports = { broadcastMessage, setBroadcastBot };
