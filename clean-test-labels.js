#!/usr/bin/env node
/**
 * Script de nettoyage : Supprime tous les "test", "test test" et placeholders des settings
 * Usage: node clean-test-labels.js
 */
require('dotenv').config();
const { supabase } = require('./config/supabase');

const PROPER_DEFAULTS = {
    // Labels UI principaux
    bot_name: 'La Frappe IDF',
    welcome_message: 'Bienvenue ! Vous faites partie de la famille.',
    label_catalog: 'Catalogue Produits',
    label_my_orders: 'Mes Commandes',
    label_contact: 'Contact',
    label_channel: 'Canal Telegram',
    label_welcome: 'Message d\'accueil',
    label_profile: 'Mon Profil & Parrainage',
    label_admin_bot: 'Console Admin',
    label_admin_web: 'Dashboard Web',
    label_livreur: 'Espace Livreur',
    label_livreur_space: 'Espace Livreur',
    label_help: 'Aide / Support',

    // Messages système
    msg_choose_qty: 'Choisissez la quantité :',
    msg_search_livreur: '🔍 Recherche d\'un livreur disponible...',
    msg_order_success: '✅ Commande validée avec succès !',
    msg_help_intro: 'Besoin d\'aide ? Choisissez une option ci-dessous :',

    // Statuts commandes
    status_pending_label: 'En attente',
    status_taken_label: 'Prise en charge',
    status_delivered_label: 'Livrée',
    status_cancelled_label: 'Annulée',

    // Icons UI
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
    ui_icon_taken: '🚚',
    ui_icon_notification: '🔔',
    ui_icon_wallet: '💰',
    ui_icon_points: '⭐',
    ui_icon_stats: '📊',
    ui_icon_broadcast: '📢',
    ui_icon_logout: '🚪',
    ui_icon_help: '❓'
};

async function cleanTestLabels() {
    console.log('🧹 Nettoyage des valeurs "test" dans bot_settings...\n');

    try {
        // 1. Récupérer les settings actuels
        const { data: settings, error: fetchError } = await supabase
            .from('bot_settings')
            .select('*')
            .limit(1);

        if (fetchError) {
            console.error('❌ Erreur de lecture des settings:', fetchError.message);
            process.exit(1);
        }

        if (!settings || settings.length === 0) {
            console.log('⚠️  Aucun settings trouvé. Création des valeurs par défaut...');
            const { error: insertError } = await supabase
                .from('bot_settings')
                .insert([{ id: 'config', ...PROPER_DEFAULTS }]);

            if (insertError) {
                console.error('❌ Erreur de création:', insertError.message);
                process.exit(1);
            }
            console.log('✅ Settings créés avec succès !');
            return;
        }

        const currentSettings = settings[0];
        const settingsId = currentSettings.id;

        // 2. Identifier les champs contenant "test"
        const updates = {};
        let countFixed = 0;

        // Liste des colonnes réellement présentes dans la table
        const availableColumns = Object.keys(currentSettings);

        for (const [key, value] of Object.entries(currentSettings)) {
            if (typeof value === 'string') {
                const lowerValue = value.toLowerCase();
                // Détecter "test", "test test", ou valeurs vides/nulles
                if (lowerValue === 'test' || lowerValue === 'test test' || !value.trim() || value === 'null') {
                    if (PROPER_DEFAULTS[key]) {
                        updates[key] = PROPER_DEFAULTS[key];
                        console.log(`🔧 ${key}: "${value}" → "${PROPER_DEFAULTS[key]}"`);
                        countFixed++;
                    }
                }
            }
        }

        // 3. Compléter les colonnes présentes avec les défauts si elles sont vides ou "test"
        for (const col of availableColumns) {
            if (PROPER_DEFAULTS[col] && (!currentSettings[col] || currentSettings[col].toLowerCase().includes('test'))) {
                if (!updates[col]) {
                    updates[col] = PROPER_DEFAULTS[col];
                    console.log(`🔧 ${col}: (réparé) → "${PROPER_DEFAULTS[col]}"`);
                    countFixed++;
                }
            }
        }

        if (countFixed === 0) {
            console.log('✅ Aucune valeur "test" trouvée. Tout est propre !');
            return;
        }

        // 4. Appliquer les mises à jour
        const { error: updateError } = await supabase
            .from('bot_settings')
            .update(updates)
            .eq('id', settingsId);

        if (updateError) {
            console.error('❌ Erreur de mise à jour:', updateError.message);
            console.log('Détail des updates tentées:', updates);
            process.exit(1);
        }

        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`✅ ${countFixed} champs nettoyés avec succès !`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    } catch (err) {
        console.error('❌ Erreur fatale:', err.message);
        process.exit(1);
    }
}

cleanTestLabels();

