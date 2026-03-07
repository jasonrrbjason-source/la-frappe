# 🤖 Bot Telegram Prestige Club (V5)

Un bot Telegram robuste conçu avec **Node.js (Telegraf)** et **Firebase Firestore**, incluant une **interface web d'administration premium**.

## ✨ Fonctionnalités

### 👤 Utilisateur (Bot)
- **Inscription automatique** : Sauvegarde de l'ID, username, prénom et date d'inscription.
- **Système de parrainage** : Lien unique par utilisateur, compteur de filleuls et classement.
- **Menu interactif** : Accès rapide au contact privé, au canal Telegram et au message d'accueil.
- **Détection de blocage** : Le bot détecte automatiquement si un utilisateur l'a bloqué pour nettoyer la base de données.

### 🛠 Administration (Bot & Web)
- **Dashboard Premium** : Statistiques en temps réel, graphiques d'inscription (Chart.js), gestion des utilisateurs.
- **Système de Broadcast** : 
  - Envoi à TOUS les utilisateurs.
  - Gestion des **Rate Limits** de Telegram (30 msg/sec).
  - Saut automatique des comptes bloqués/supprimés.
- **Statistiques avancées** : Inscriptions quotidiennes, taux de rétention, top parrains.
- **Commandes Admin (Telegram)** : `/broadcast`, `/stats`, `/users`, `/leaderboard`.

---

## 🚀 Installation & Configuration

### 1. Prérequis
- [Node.js v18+](https://nodejs.org/)
- Un compte [Firebase](https://console.firebase.google.com/) (Gratuit)
- Un token de bot via [@BotFather](https://t.me/BotFather)

### 2. Configuration Firebase
1. Créez un projet sur la console Firebase.
2. Activez **Firestore Database** en mode production (puis passez les règles en "allow read, write: if true;" pour le développement ou utilisez le SDK Admin).
3. Allez dans **Paramètres du projet** > **Comptes de service**.
4. Cliquez sur **Générer une nouvelle clé privée**.
5. Renommez le fichier téléchargé en `serviceAccountKey.json` et placez-le à la racine du projet.

### 3. Variables d'environnement
Créez un fichier `.env` à la racine (utilisez `.env.example` comme modèle) :
```env
BOT_TOKEN=123456789:ABCDEF...
ADMIN_TELEGRAM_ID=VotreIDTelegram
ADMIN_PASSWORD=votre_mot_de_passe_dashboard
PORT=3000
```

### 4. Lancement
```bash
# Installer les dépendances
npm install

# Lancer en mode développement
npm run dev

# Lancer en production
npm start
```

---

## 🌐 Déploiement

### Railway / Render
Ce projet est prêt pour le déploiement sur Railway ou Render :
1. Connectez votre dépôt GitHub.
2. Ajoutez les variables d'environnement (du `.env`) dans les paramètres du service.
3. Pour la clé Firebase en production, copiez le contenu du JSON dans `FIREBASE_PRIVATE_KEY` et remplissez `FIREBASE_CLIENT_EMAIL` et `FIREBASE_PROJECT_ID` (voir `config/firebase.js`).

---

## 🛠 Maintenance & Sécurité
- **Doublons** : Gérés par l'utilisation de l'ID Telegram comme ID de document Firestore.
- **Rate Limits** : Le service de broadcast utilise un système de batching (25 messages par lot avec délai) pour éviter le bannissement par Telegram.
- **Erreurs API** : Chaque envoi est wrappé dans un bloc try/catch pour assurer la stabilité globale.

---

## 📈 Onboarding Admin
1. **Démarrer le bot** : Envoyez `/start` à votre bot.
2. **Accéder au Web** : Ouvrez `http://localhost:3000` (ou votre URL de déploiement).
3. **Diffuser un message** : Utilisez `/broadcast Hello members!` sur Telegram ou utilisez l'onglet "Broadcast" sur le dashboard web.
