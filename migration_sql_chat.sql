-- =========================================================================
-- MIGRATION : NOUVELLES FONCTIONNALITÉS (CHAT, AIDE, ADMINS, BAN)
-- À EXÉCUTER DANS LE SQL EDITOR DE SUPABASE
-- =========================================================================

-- 1. MISE À JOUR DE LA TABLE COMMANDES (Chat & Aide)
-- Indispensable pour que le chat et le relayage des messages fonctionnent
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS chat_count INTEGER DEFAULT 0;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS help_requests JSONB DEFAULT '[]'::jsonb;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS client_reply TEXT;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS delay_reason TEXT;

-- 2. MISE À JOUR DE LA TABLE RÉGLAGES (Labels & Textes d'aide)
-- Nouveaux champs pour personnaliser les messages d'aide
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_help_intro TEXT DEFAULT 'Besoin d''aide ? Choisissez une option ci-dessous :';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_help_where_order TEXT DEFAULT 'Où en est ma commande ?';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_help_contact_admin TEXT DEFAULT 'Parler à l''Admin';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_help_return TEXT DEFAULT 'Retour au Menu';

-- 3. MISE À JOUR DE LA TABLE UTILISATEURS (Bannissement)
-- Permet de bloquer/banir un utilisateur directement via le bot ou dashboard
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

-- =========================================================================
-- FIN DE LA MIGRATION
-- =========================================================================
