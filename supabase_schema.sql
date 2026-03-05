-- =========================================================================
-- SCHÉMA SUPABASE COMPLET - RÉPLIQUE EXACTE FIREBASE (COLONNE PAR COLONNE)
-- =========================================================================

-- 1. Table Utilisateurs (bot_users)
CREATE TABLE IF NOT EXISTS bot_users (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  platform TEXT,
  platform_id TEXT,
  type TEXT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_active BOOLEAN DEFAULT true,
  is_blocked BOOLEAN DEFAULT false,
  is_livreur BOOLEAN DEFAULT false,
  is_admin BOOLEAN DEFAULT false,
  referred_by TEXT,
  referral_count NUMERIC DEFAULT 0,
  order_count NUMERIC DEFAULT 0,
  points NUMERIC DEFAULT 0,
  wallet_balance NUMERIC DEFAULT 0,
  is_available BOOLEAN DEFAULT false,
  referral_code TEXT,
  tracked_messages JSONB DEFAULT '[]'::jsonb,
  last_menu_id NUMERIC,
  date_inscription TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  current_city TEXT,
  data JSONB DEFAULT '{}'::jsonb
);

-- 2. Table Produits (bot_products)
CREATE TABLE IF NOT EXISTS bot_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  unit TEXT,
  unit_value TEXT,
  promo TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Table Commandes (bot_orders)
CREATE TABLE IF NOT EXISTS bot_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  product_name TEXT,
  quantity NUMERIC,
  total_price NUMERIC,
  discount_applied NUMERIC DEFAULT 0,
  city TEXT,
  platform TEXT,
  status TEXT DEFAULT 'pending',
  points_awarded BOOLEAN DEFAULT false,
  livreur_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

-- 4. Table Diffusions / Broadcasts (bot_broadcasts)
CREATE TABLE IF NOT EXISTS bot_broadcasts (
  id TEXT PRIMARY KEY,
  message TEXT,
  total_target NUMERIC DEFAULT 0,
  success NUMERIC DEFAULT 0,
  failed NUMERIC DEFAULT 0,
  blocked NUMERIC DEFAULT 0,
  target_platform TEXT,
  media_count NUMERIC DEFAULT 0,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TEXT
);

-- 5. Table Statistiques Générales & Quotidiennes (bot_stats)
CREATE TABLE IF NOT EXISTS bot_stats (
  id TEXT PRIMARY KEY,
  date TEXT,
  start_commands NUMERIC DEFAULT 0,
  new_users NUMERIC DEFAULT 0,
  total_orders NUMERIC DEFAULT 0,
  total_users NUMERIC DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_daily_stats (
  id TEXT PRIMARY KEY,
  date TEXT,
  users NUMERIC DEFAULT 0,
  orders NUMERIC DEFAULT 0,
  revenue NUMERIC DEFAULT 0
);

-- 6. Table Parrainages (bot_referrals)
CREATE TABLE IF NOT EXISTS bot_referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT,
  referred_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Table Paramètres & Configuration (bot_settings)
CREATE TABLE IF NOT EXISTS bot_settings (
  id TEXT PRIMARY KEY,
  bot_name TEXT,
  dashboard_title TEXT,
  admin_telegram_id TEXT,
  admin_password TEXT,
  dashboard_url TEXT,
  welcome_message TEXT,
  accent_color TEXT,
  languages TEXT,
  points_ratio NUMERIC,
  points_exchange NUMERIC,
  ref_bonus NUMERIC,
  
  -- UI / Boutons / Labels
  status_pending_label TEXT,
  status_taken_label TEXT,
  status_delivered_label TEXT,
  status_cancelled_label TEXT,
  label_profile TEXT,
  label_contact TEXT,
  label_livreur_space TEXT,
  label_welcome TEXT,
  label_catalog TEXT,
  label_admin_bot TEXT,
  label_channel TEXT,
  label_admin_web TEXT,
  label_my_orders TEXT,

  msg_choose_qty TEXT,
  msg_search_livreur TEXT,
  msg_order_success TEXT,

  -- UI Icons
  ui_icon_catalog TEXT,
  ui_icon_web TEXT,
  ui_icon_stats TEXT,
  ui_icon_channel TEXT,
  ui_icon_livreur TEXT,
  ui_icon_pending TEXT,
  ui_icon_broadcast TEXT,
  ui_icon_logout TEXT,
  ui_icon_contact TEXT,
  ui_icon_notification TEXT,
  ui_icon_welcome TEXT,
  ui_icon_profile TEXT,
  ui_icon_wallet TEXT,
  ui_icon_error TEXT,
  ui_icon_admin TEXT,
  ui_icon_orders TEXT,
  ui_icon_success TEXT,
  ui_icon_points TEXT
);

-- =========================================================================
-- CONFIGURATION DU STOCKAGE (STORAGE)
-- =========================================================================

-- Crée un bucket de stockage public pour les médias
INSERT INTO storage.buckets (id, name, public) 
VALUES ('uploads', 'uploads', true) 
ON CONFLICT DO NOTHING;

-- Règle pour permettre à tout le monde de lire les images/vidéos
CREATE POLICY "Public Access" 
ON storage.objects FOR SELECT 
USING (bucket_id = 'uploads');

-- Règle pour permettre au serveur Node.js d'envoyer/supprimer des fichiers
CREATE POLICY "Service Role Full Access" 
ON storage.objects FOR ALL 
USING (auth.role() = 'service_role');
