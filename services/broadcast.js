const { getAllActiveUsers, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');
const { registry } = require('../channels/ChannelRegistry');

// Rate limits: Batching global pour eviter de saturer les serveurs.
// Telegram: ~30 msg/sec, Meta WhatsApp: Varie selon le tier de numero.
const BATCH_SIZE = 25;
const DELAY_BETWEEN_BATCHES_MS = 1100; // ~1.1 sec entre les lots

/**
 * Envoie un message broadcast à une plateforme spécifique ou à tous.
 * @param {string|'all'} platform - 'telegram', 'whatsapp' ou 'all'
 * @param {string} message - Le message à envoyer
 * @param {object} options - Options supplémentaires (template, etc.)
 */
async function broadcastMessage(platform, message, options = {}) {
    const { media_url, media_type } = options;
    // 1. Recupere les utilisateurs actifs
    const users = await getAllActiveUsers(platform === 'all' ? null : platform);
    const totalUsers = users.length;

    if (totalUsers === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // 2. Initialise le log broadcast en DB
    const broadcastId = await saveBroadcast({
        message: message ? message.substring(0, 500) : `[Media: ${media_type || 'photo'}]`,
        total_target: totalUsers,
        target_platform: platform,
        media_url: media_url || null,
        media_type: media_type || null,
        status: 'in_progress',
        success: 0,
        failed: 0,
        blocked: 0,
    });

    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    console.log(`🚀 Starting broadcast to ${totalUsers} users on platform: ${platform}`);

    // 3. Boucle par lots
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map((user) => {
                console.log(`  - Sending to ${user.platform}:${user.platform_id} (${user.doc_id})`);
                return sendToUser(user, message, options);
            })
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const { success, blocked, error } = result.value;
                if (success) successCount++;
                else if (blocked) blockedCount++;
                else failedCount++;
            } else {
                failedCount++;
            }
        }

        if (i + BATCH_SIZE < users.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
        }
    }

    // 4. Finalise le log en DB
    await updateBroadcast(broadcastId, {
        status: 'completed',
        success: successCount,
        failed: failedCount,
        blocked: blockedCount,
        completed_at: new Date().toISOString(),
    });

    return { success: successCount, failed: failedCount, blocked: blockedCount, total: totalUsers, broadcastId };
}

/**
 * Delegue l'envoi au canal correspondant au type d'utilisateur.
 */
async function sendToUser(user, message, options = {}) {
    const channel = registry.query(user.platform);

    if (!channel || !channel.isActive) {
        const reason = !channel ? 'Canal inexistant' : 'Canal non actif';
        console.warn(`⚠️ Impossible d'envoyer à ${user.platform_id}: ${reason}`);
        return { success: false, error: reason };
    }

    try {
        let result;

        // WhatsApp specific: Si en dehors de la fenetre de session (24h), on doit utiliser un template.
        if (user.platform === 'whatsapp' && !channel.isInSessionWindow(user.platform_id)) {
            if (options.template) {
                // Utilise le template de broadcast fourni dans options
                result = await channel.sendTemplate(user.platform_id, options.template, user.language_code || 'fr', options.components);
            } else {
                // Si pas de template fourni et pas en session -> Echec probable sur WhatsApp API
                // On tente quand meme de l'envoyer comme texte, l'API renverra un code 131047
                result = await channel.sendMessage(user.platform_id, message, options);
            }
        } else {
            // Telegram ou WhatsApp en session
            result = await channel.sendMessage(user.platform_id, message, options);
        }

        if (!result.success && result.blocked) {
            await markUserBlocked(user.doc_id);
            return { success: false, blocked: true, error: result.error };
        }

        return result; // contains { success: boolean, error: string? }
    } catch (error) {
        console.error(`❌ Unexpected error sending to ${user.platform_id}:`, error);
        return { success: false, error: error.message };
    }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { broadcastMessage };
