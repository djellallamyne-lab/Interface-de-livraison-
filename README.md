# Interface de livraison

Tableau de bord pour gérer les livraisons et les livreurs, avec notifications WhatsApp.

Le dépôt ne contient **aucune donnée d’exploitation** : pas de livreurs, pas de commandes, pas de session WhatsApp. Une base SQLite vide est créée au premier lancement.

## Fonctionnalités

- Création et suivi des commandes (en attente / en livraison)
- Assignation d’une ou plusieurs commandes à un livreur
- Inscription des livreurs via WhatsApp
- Acceptation, refus et confirmation de livraison par message
- Statistiques et historique

## Prérequis

- [Node.js](https://nodejs.org/) 18 ou plus
- Google Chrome, Microsoft Edge, ou Chromium (pour WhatsApp Web)

## Installation

```bash
git clone https://github.com/djellallamyne-lab/Interface-de-livraison-.git
cd Interface-de-livraison-
npm --prefix backend install
```

## Démarrage

```bash
npm start
```

Ouvrir [http://localhost:3000](http://localhost:3000)

1. Cliquer sur le badge **WhatsApp** en haut à droite
2. Générer le QR et le scanner avec WhatsApp → Appareils connectés

## Pages

| URL | Description |
|-----|-------------|
| `/` | Tableau de bord : commandes, livreurs, assignation |
| `/livreurs.html` | Fiche livreur et historique des courses |

## Commandes WhatsApp (livreurs)

| Message | Action |
|---------|--------|
| `bonjour` | Inscription (prénom, puis numéro si besoin) |
| `disponible` | Prêt à recevoir des courses |
| `indisponible` | Pause |
| `statut` | Voir les commandes en cours |
| `accepté 1` | Accepter la commande 1 |
| `refusé 1` | Refuser la commande 1 |
| `livré 1` | Marquer la commande 1 comme livrée |

Les numéros `1`, `2`, `3` sont locaux à la tournée du livreur. Ils recommencent à `1` à la tournée suivante.

## Configuration optionnelle

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `3000` | Port HTTP |
| `ADMIN_API_KEY` | _(vide)_ | Si défini, les routes `/api/*` exigent le header `x-api-key` |
| `ASSIGN_TIMEOUT_MINUTES` | `15` | Remet en attente une commande assignée sans réponse |
| `PUPPETEER_EXECUTABLE_PATH` | auto | Chemin vers Chrome / Chromium |

PowerShell :

```powershell
$env:PORT="3000"
$env:ADMIN_API_KEY="mon-secret"
npm start
```

Dans le navigateur, si l’auth API est activée :

```js
localStorage.setItem('ADMIN_API_KEY', 'mon-secret')
```

## Données locales (non versionnées)

Ces fichiers restent sur la machine et ne sont **pas** poussés sur GitHub :

- `database.sqlite` — livreurs, commandes, historique
- `backend/.wwebjs_auth/` — session WhatsApp
- `backend/.wwebjs_cache/` — cache WhatsApp Web

Pour repartir de zéro en local, supprimer `database.sqlite` puis relancer le serveur.
