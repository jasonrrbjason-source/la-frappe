const { getAllActiveUsers, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');

const BATCH_SIZE = 25;
const MEDIA_BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 1200;

// Référence au bot Telegram (sera définie par server.js)
let _bot = null;
function setBroadcastBot(bot) { _bot = bot; }

async function broadcastMessage(platform, message, options = {}) {
    const { mediaFiles = [] } = options;

    // Récupérer les utilisateurs ET les groupes
    const [users, groups] = await Promise.all([
        getAllActiveUsers(platform === 'all' ? null : 'telegram', 'user'),
        getAllActiveUsers(platform === 'all' ? null : 'telegram', 'group')
    ]);

    const targets = [...users, ...groups];
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

        const results = await Promise.allSettled(
            batch.map((user) => sendToUser(user, message, options))
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const { success, blocked } = result.value;
                if (success) successCount++;
                else if (blocked) blockedCount++;
                else failedCount++;
            } else {
                failedCount++;
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
                const isVideo = f.mimetype.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i);
                return {
                    type: isVideo ? 'video' : 'photo',
                    media: { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') },
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });
            await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
        } else if (mediaFiles.length === 1) {
            const f = mediaFiles[0];
            const isVideo = f.mimetype.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i);
            const source = { source: f.data, filename: f.name || (isVideo ? 'video.mp4' : 'photo.jpg') };
            if (isVideo) {
                await _bot.telegram.sendVideo(chatId, source, { caption: caption, parse_mode: 'HTML' });
            } else {
                await _bot.telegram.sendPhoto(chatId, source, { caption: caption, parse_mode: 'HTML' });
            }
        } else {
            await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
        return { success: true };
    } catch (error) {
        if (error.code === 403 || error.description?.includes('blocked')) {
            await markUserBlocked(user.doc_id);
            return { success: false, blocked: true, error: error.message };
        }
        console.error(`Broadcast to ${chatId} error:`, error.message);
        return { success: false, error: error.message };
    }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { broadcastMessage, setBroadcastBot };
