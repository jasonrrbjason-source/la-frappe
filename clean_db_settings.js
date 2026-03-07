const { supabase, COL_SETTINGS } = require('./services/database');

const SETTINGS_DEFAULTS = {
    label_catalog: 'Catalogue Produits',
    label_my_orders: 'Mes Commandes',
    label_contact: 'Contact Admin',
    label_channel: 'Lien Canal Telegram',
    label_welcome: 'Message d\'accueil',
    label_profile: 'Mon Profil / Parrainage',
    label_admin_bot: 'Gestion Bot',
    label_admin_web: 'Dashboard Web',
    label_livreur: 'Espace Livreur',
    label_help: 'Aide & Support',
    private_contact_url: 'https://t.me/lafrappex',
    channel_url: 'https://t.me/lafrappe_canal'
};

async function cleanSettings() {
    console.log('--- Cleaning database settings ---');
    const { data: config } = await supabase.from(COL_SETTINGS).select('*').eq('id', 'config').single();
    if (!config) {
        console.log('No config found, creating with defaults...');
        await supabase.from(COL_SETTINGS).insert([{ id: 'config', ...SETTINGS_DEFAULTS }]);
        return;
    }

    const updates = {};
    for (const [key, defaultVal] of Object.entries(SETTINGS_DEFAULTS)) {
        const currentVal = config[key];
        // If column exists and contains "test"
        if (config[key] !== undefined && typeof currentVal === 'string' && currentVal.toLowerCase().includes('test')) {
            updates[key] = defaultVal;
            console.log(`Repairing ${key}: "${currentVal}" -> "${defaultVal}"`);
        }
    }

    // Force update labels requested by user if they don't match the expectation
    if (config.label_channel !== 'Lien Canal Telegram') {
        updates.label_channel = 'Lien Canal Telegram';
        console.log(`Updating label_channel: "${config.label_channel}" -> "Lien Canal Telegram"`);
    }
    if (config.label_help !== 'Aide & Support') {
        updates.label_help = 'Aide & Support';
        console.log(`Updating label_help: "${config.label_help}" -> "Aide & Support"`);
    }
    if (!config.label_livreur_space || (config.label_livreur_space && config.label_livreur_space.toLowerCase().includes('test'))) {
        updates.label_livreur_space = 'Espace Livreur';
        console.log(`Updating label_livreur_space: "${config.label_livreur_space}" -> "Espace Livreur"`);
    }

    if (Object.keys(updates).length > 0) {
        await supabase.from(COL_SETTINGS).update(updates).eq('id', 'config');
        console.log('Settings updated successfully.');
    } else {
        console.log('Nothing to clean.');
    }
}

cleanSettings().catch(console.error);
