const { getAllActiveUsers, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');

const BATCH_SIZE = 25;
const MEDIA_BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 1200;

// Référence au bot Telegram (sera définie par server.js)
let _bot = null;
function setBroadcastBot(bot) { _bot = bot; }

async function broadcastMessage(platform, message, options = {}) {
    const { mediaFiles = [] } = options;
    const users = await getAllActiveUsers(platform === 'all' ? null : 'telegram');
    const totalUsers = users.length;

    if (totalUsers === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    const broadcastId = await saveBroadcast({
        message: message ? message.substring(0, 500) : `[Média: ${mediaFiles.length} fichiers]`,
        total_target: totalUsers,
        target_platform: platform,
        media_count: mediaFiles.length,
        status: 'in_progress',
        success: 0, failed: 0, blocked: 0,
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const currentBatchSize = mediaFiles.length > 0 ? MEDIA_BATCH_SIZE : BATCH_SIZE;
    console.log(`🚀 Diffusion à ${totalUsers} utilisateurs (Batch: ${currentBatchSize})...`);

    for (let i = 0; i < users.length; i += currentBatchSize) {
        const batch = users.slice(i, i + currentBatchSize);

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

        if (i + currentBatchSize < users.length) {
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
    return { success: successCount, failed: failedCount, blocked: blockedCount, total: totalUsers, broadcastId };
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
                const isVideo = f.mimetype.startsWith('video');
                return {
                    type: isVideo ? 'video' : 'photo',
                    media: { source: Buffer.from(f.data) },
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });
            await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
        } else if (mediaFiles.length === 1) {
            const f = mediaFiles[0];
            const isVideo = f.mimetype.startsWith('video');
            const source = { source: Buffer.from(f.data) };
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
