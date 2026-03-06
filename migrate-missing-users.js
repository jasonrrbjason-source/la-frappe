#!/usr/bin/env node
/**
 * Migration : Copie tous les utilisateurs de bot_orders vers bot_users
 * Usage: node migrate-missing-users.js
 */
require('dotenv').config();
const { supabase } = require('./config/supabase');
const { registerUser } = require('./services/database');

async function migrateMissingUsers() {
    console.log('🔍 Recherche des utilisateurs manquants...\n');

    // 1. Récupère tous les orders avec user_id, username, first_name uniques
    const { data: orders, error: ordersError } = await supabase
        .from('bot_orders')
        .select('user_id, username, first_name')
        .not('user_id', 'is', null);

    if (ordersError) {
        console.error('❌ Erreur de lecture des commandes:', ordersError.message);
        process.exit(1);
    }

    // 2. Groupe par user_id pour éviter les doublons
    const uniqueUsers = new Map();
    orders.forEach(order => {
        if (!uniqueUsers.has(order.user_id)) {
            uniqueUsers.set(order.user_id, {
                user_id: order.user_id,
                username: order.username,
                first_name: order.first_name
            });
        }
    });

    console.log(`📊 ${uniqueUsers.size} utilisateurs uniques trouvés dans les commandes\n`);

    // 3. Vérifie lesquels existent déjà dans bot_users
    const { data: existingUsers } = await supabase
        .from('bot_users')
        .select('id');

    const existingIds = new Set(existingUsers?.map(u => u.id) || []);

    // 4. Filtre ceux qui manquent
    const missingUsers = Array.from(uniqueUsers.values()).filter(u => !existingIds.has(u.user_id));

    console.log(`⚠️  ${missingUsers.length} utilisateurs manquants dans bot_users\n`);

    if (missingUsers.length === 0) {
        console.log('✅ Aucune migration nécessaire. Tous les utilisateurs existent déjà.\n');
        process.exit(0);
    }

    // 5. Crée les utilisateurs manquants
    let created = 0;
    let failed = 0;

    for (const userData of missingUsers) {
        try {
            const tgId = userData.user_id.replace('telegram_', '');
            await registerUser({
                id: tgId,
                username: userData.username || '',
                first_name: userData.first_name || 'Client',
                type: 'user'
            });
            created++;
            console.log(`✅ ${userData.first_name || 'Client'} (${userData.user_id})`);
        } catch (e) {
            failed++;
            console.error(`❌ ${userData.user_id}: ${e.message}`);
        }
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ ${created} utilisateurs créés`);
    console.log(`❌ ${failed} échecs`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

migrateMissingUsers().catch(err => {
    console.error('❌ Erreur fatale:', err.message);
    process.exit(1);
});
