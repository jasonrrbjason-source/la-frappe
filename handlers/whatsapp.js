const { registerUser, incrementDailyStat, getAppSettings } = require('../services/database');

/**
 * Gère les messages entrants du canal WhatsApp.
 */
async function handleWhatsAppMessage(channel, msg) {
    try {
        const { from, name, text, type } = msg;
        const settings = await getAppSettings();

        // Vérifier si c'est une commande de démarrage ou un code de parrainage
        let referrerId = null;
        if (text && text.toLowerCase().startsWith('ref_')) {
            // Dans ce bot, le lien de parrainage contient l'ID utilisateur.
            // WhatsApp n'a pas de /start avec payload comme Telegram,
            // donc on suppose que l'utilisateur envoie son code de parrainage directement ou via un clic.
            const parts = text.split('_');
            if (parts.length >= 3) {
                // Le format du code est ref_platform_id_random
                // On extrait l'id du parrain
                referrerId = parts[2]; // ex: ref_telegram_501234567_abc -> 501234567
            }
        }

        // Simuler un objet utilisateur pour registerUser
        const platformUser = {
            id: from,
            first_name: name,
            username: from, // WhatsApp n'a pas de username public comme Telegram, on utilise l'id
            language_code: 'fr',
        };

        const { isNew, user: registeredUser } = await registerUser(platformUser, 'whatsapp', referrerId);

        await incrementDailyStat('whatsapp_messages');

        if (text && text.toLowerCase() === 'menu') {
            return sendWhatsAppMenu(channel, from, settings, registeredUser);
        }

        if (isNew) {
            const welcomeMsg = `✨ *Bienvenue sur ${settings.bot_name}, ${name} !*\n\n` +
                `${settings.welcome_message}\n\n` +
                `📋 *Votre profil :*\n` +
                `├ 👤 Nom : *${name}*\n` +
                `├ 🆔 ID : \`${from}\`\n` +
                `└ 📅 Inscrit : *Aujourd'hui*\n\n` +
                (referrerId ? `🎁 _Vous avez été invité par un membre !_\n\n` : '') +
                `🔗 *Votre lien de parrainage :*\n` +
                `\`https://wa.me/${channel.phoneNumberId}?text=${registeredUser.referral_code}\`\n\n` +
                `Partagez ce lien ou envoyez votre code pour inviter vos amis ! 🚀`;

            await channel.sendInteractive(from, welcomeMsg, [
                { id: 'menu', title: '🏠 Menu' },
                { id: 'contact', title: '📱 Contact' }
            ]);
        } else {
            // Traitement des boutons interactifs
            if (text === 'contact') {
                return channel.sendMessage(from, `📱 *Contact privé :*\n${settings.private_contact_url}`);
            }
            if (text === 'channel') {
                return channel.sendMessage(from, `📢 *Rejoindre le canal :*\n${settings.channel_url}`);
            }

            // Par défaut, proposer le menu
            const backMsg = `👋 *Ravi de vous revoir, ${name} !*\nEnvoyez "menu" pour voir les options.`;
            await channel.sendInteractive(from, backMsg, [
                { id: 'menu', title: '🏠 Menu Principal' }
            ]);
        }
    } catch (error) {
        console.error('❌ Erreur WhatsApp handler:', error);
    }
}

async function sendWhatsAppMenu(channel, from, settings, user) {
    const menuMsg = `📋 *Menu Principal - ${settings.bot_name}*\n\nChoisissez une option :`;
    await channel.sendInteractive(from, menuMsg, [
        { id: 'contact', title: '📱 Contact Privé' },
        { id: 'channel', title: '📢 Canal' },
        { id: 'referrals', title: '🎁 Parrainage' }
    ]);
}

module.exports = { handleWhatsAppMessage };
