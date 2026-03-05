const { getAllActiveUsers, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');

const BATCH_SIZE = 25;
const MEDIA_BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 1200;

// Référence au bot Telegram (sera définie par server.js)
let _bot = null;
function setBroadcastBot(bot) { _bot = bot; }

async function broadcastMessage(platform, message, options = {}) {
    const { mediaFiles = [] } = options;

    // Récupérer toutes les cibles (users + groups) en une seule fois
    const targets = await getAllActiveUsers(platform === 'all' ? null : 'telegram');
    const totalTargets = targets.length;

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    const broadcastId = await saveBroadcast({
        message: message ? message.substring(0, 500) : `[Média: ${mediaFiles.length} fichiers]`,
        total_target: totalTargets,
        target_platform: platform,
        media_count: mediaFiles.length,
        status: 'in_progress',
        success: 0, failed: 0, blocked: 0,
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const currentBatchSize = mediaFiles.length > 0 ? MEDIA_BATCH_SIZE : BATCH_SIZE;
    console.log(`🚀 Diffusion à ${totalTargets} cibles (Batch: ${currentBatchSize})...`);

    for (let i = 0; i < targets.length; i += currentBatchSize) {
        const batch = targets.slice(i, i + currentBatchSize);
        console.log(`[BROADCAST] Batch ${Math.floor(i / currentBatchSize) + 1} - Envoi à ${batch.length} cibles...`);

        const results = await Promise.allSettled(
            batch.map((user) => sendToUser(user, message, options))
        );

        for (const [idx, result] of results.entries()) {
            const target = batch[idx];
            if (result.status === 'fulfilled') {
                const { success, blocked, error } = result.value;
                if (success) {
                    successCount++;
                } else {
                    if (blocked) blockedCount++;
                    else failedCount++;
                    console.error(`[BROADCAST] ❌ Échec pour ${target.platform_id} (${target.first_name}): ${error}`);
                }
            } else {
                failedCount++;
                console.error(`[BROADCAST] ❌ Erreur fatale batch pour ${target.platform_id}:`, result.reason);
            }
        }

        if (i + currentBatchSize < targets.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
        }
    }

    await updateBroadcast(broadcastId, {
        status: 'completed',
        success: successCount,
        failed: failedCount,
        blocked: blockedCount,
        completed_at: new Date().toISOString(),
    });

    console.log(`✅ Diffusion terminée: ${successCount} OK, ${failedCount} échoués, ${blockedCount} bloqués`);
    return { success: successCount, failed: failedCount, blocked: blockedCount, total: totalTargets, broadcastId };
}

async function sendToUser(user, message, options = {}) {
    if (!_bot) {
        return { success: false, error: 'Bot non initialisé' };
    }

    const chatId = user.platform_id;
    const { mediaFiles = [] } = options;

    // Telegram caption limit: 1024 chars. Truncate if needed to avoid error.
    const caption = message ? (message.length > 1024 ? message.substring(0, 1021) + '...' : message) : '';

    try {
        if (mediaFiles.length > 1) {
            // Envoi en groupe de médias (max 10)
            const mediaGroup = mediaFiles.slice(0, 10).map((f, i) => {
                const isVideo = f.mimetype?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i);
                return {
                    type: isVideo ? 'video' : 'photo',
                    media: { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') },
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });
            console.log(`[BROADCAST] Envoi MediaGroup (${mediaGroup.length} fichiers) à ${chatId}`);
            await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
        } else if (mediaFiles.length === 1) {
            const f = mediaFiles[0];
            const isVideo = f.mimetype?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i);
            const source = { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') };
            console.log(`[BROADCAST] Envoi ${isVideo ? 'VIDEO' : 'PHOTO'} à ${chatId} (${f.data.length} bytes)`);
            if (isVideo) {
                await _bot.telegram.sendVideo(chatId, source, { caption: caption, parse_mode: 'HTML' });
            } else {
                await _bot.telegram.sendPhoto(chatId, source, { caption: caption, parse_mode: 'HTML' });
            }
        } else {
            console.log(`[BROADCAST] Envoi MESSAGE TEXTE à ${chatId}`);
            await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
        return { success: true };
    } catch (error) {
        console.error(`[BROADCAST] 🚨 Erreur Telegram pour ${chatId}:`, {
            code: error.code,
            description: error.description,
            message: error.message
        });
        if (error.code === 403 || error.description?.includes('blocked') || error.description?.includes('chat not found')) {
            await markUserBlocked(user.doc_id);
            return { success: false, blocked: true, error: error.description || error.message };
        }
        return { success: false, error: error.description || error.message };
    }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { broadcastMessage, setBroadcastBot };
