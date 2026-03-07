#!/usr/bin/env node
/**
 * Diagnostic : Vérifie la configuration admin et teste les notifications
 * Usage: node check-admin-config.js
 */
require('dotenv').config();
const { supabase } = require('./config/supabase');

async function checkAdminConfig() {
    console.log('🔍 Vérification de la configuration admin...\n');

    try {
        // 1. Vérifier la variable d'environnement
        const envAdminId = process.env.ADMIN_TELEGRAM_ID;
        console.log('📌 Variable .env ADMIN_TELEGRAM_ID:', envAdminId || '❌ NON DÉFINIE');

        // 2. Vérifier la base de données
        const { data: settings, error } = await supabase
            .from('bot_settings')
            .select('id, admin_telegram_id, list_admins')
            .limit(1);

        if (error) {
            console.error('\n❌ Erreur de lecture des settings:', error.message);
            process.exit(1);
        }

        if (!settings || settings.length === 0) {
            console.log('\n⚠️  PROBLÈME : Aucun settings trouvé dans bot_settings !');
            console.log('Solution : Créez un enregistrement dans bot_settings avec admin_telegram_id');
            process.exit(1);
        }

        const dbSettings = settings[0];
        console.log('\n📊 Configuration dans la base de données:');
        console.log('   - admin_telegram_id:', dbSettings.admin_telegram_id || '❌ VIDE');
        console.log('   - list_admins:', JSON.stringify(dbSettings.list_admins || []) || '[]');

        // 3. Analyser et valider les IDs
        const allAdminIds = [];

        if (dbSettings.admin_telegram_id) {
            const ids = String(dbSettings.admin_telegram_id).split(/[\s,]+/).map(id => id.trim());
            allAdminIds.push(...ids);
        }

        if (Array.isArray(dbSettings.list_admins)) {
            allAdminIds.push(...dbSettings.list_admins);
        }

        console.log('\n✅ IDs admin détectés:', allAdminIds.length > 0 ? allAdminIds.join(', ') : '❌ AUCUN');

        if (allAdminIds.length === 0) {
            console.log('\n⚠️  PROBLÈME : Aucun ID admin configuré !');
            console.log('\nSolution:');
            console.log('1. Modifiez bot_settings dans Supabase');
            console.log('2. Ajoutez admin_telegram_id = "' + envAdminId + '"');
            console.log('   (votre ID Telegram sans le préfixe "telegram_")');
            process.exit(1);
        }

        // 4. Valider le format des IDs
        console.log('\n🔎 Validation du format des IDs:');
        for (const id of allAdminIds) {
            const isValid = /^\d+$/.test(id);
            const hasPrefix = id.includes('telegram_');

            if (hasPrefix) {
                console.log(`   ❌ ${id} - ERREUR : Ne doit PAS contenir "telegram_"`);
            } else if (!isValid) {
                console.log(`   ⚠️  ${id} - ATTENTION : Doit être uniquement des chiffres`);
            } else {
                console.log(`   ✅ ${id} - OK`);
            }
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 RÉSUMÉ');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Total admins configurés : ${allAdminIds.length}`);
        console.log(`Format correct : ${allAdminIds.filter(id => /^\d+$/.test(id)).length}/${allAdminIds.length}`);

        if (allAdminIds.every(id => /^\d+$/.test(id))) {
            console.log('\n✅ Configuration admin OK ! Les notifications devraient fonctionner.');
        } else {
            console.log('\n⚠️  Corrigez les IDs invalides pour que les notifications fonctionnent.');
        }

    } catch (err) {
        console.error('\n❌ Erreur fatale:', err.message);
        process.exit(1);
    }
}

checkAdminConfig();
