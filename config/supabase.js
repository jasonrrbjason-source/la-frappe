const { createClient } = require('@supabase/supabase-js');
const { validateLicense } = require('../services/license');
// Environment variables are loaded in index.js

if (!validateLicense()) {
    console.error('❌ Licence invalide.');
    process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERREUR CRITIQUE : Identifiants Supabase manquants dans process.env');
    console.log('Clés détectées :', Object.keys(process.env).filter(k => k.includes('SUPABASE')));
    // On ne crash pas ici pour laisser le temps de voir les logs, ou on force un exit plus propre
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
