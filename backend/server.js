// backend/server.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const net = require('net');
const { reconnectWhatsApp, sendCommandeAuLivreur, sendMessage, getWhatsAppStatus } = require('./whatsapp');
const { dbUtils } = require('./database');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ASSIGN_TIMEOUT_MINUTES = Number(process.env.ASSIGN_TIMEOUT_MINUTES) || 15;

function isPortInUse(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(true));
        server.once('listening', () => {
            server.close(() => resolve(false));
        });
        server.listen(port, '127.0.0.1');
    });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Auth optionnelle : active seulement si ADMIN_API_KEY est défini
function requireAdmin(req, res, next) {
    if (!ADMIN_API_KEY) return next();
    const key = req.header('x-api-key') || req.query.api_key;
    if (key !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Non autorisé : clé API manquante ou invalide' });
    }
    next();
}

app.use('/api', requireAdmin);

function validateCommandeBody(body) {
    const client_nom = (body.client_nom || '').trim();
    const client_adresse = (body.client_adresse || '').trim();
    const contenu = (body.contenu || '').trim();
    const client_telephone = body.client_telephone ? String(body.client_telephone).trim() : null;
    const montant = body.montant === '' || body.montant == null ? null : Number(body.montant);

    if (!client_nom || !client_adresse || !contenu) {
        return { error: 'Nom, adresse et contenu sont obligatoires' };
    }
    if (montant != null && Number.isNaN(montant)) {
        return { error: 'Montant invalide' };
    }
    return {
        value: {
            numero_uber: body.numero_uber || null,
            client_nom,
            client_adresse,
            client_telephone,
            contenu,
            montant
        }
    };
}

// ============ API ADMIN ============

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        whatsapp: getWhatsAppStatus(),
        authRequired: Boolean(ADMIN_API_KEY)
    });
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json(getWhatsAppStatus());
});

app.post('/api/whatsapp/reconnect', async (req, res) => {
    try {
        const force = req.body && req.body.force === true;
        const status = getWhatsAppStatus();
        if (!force && status.ready) {
            return res.json({
                success: true,
                alreadyConnected: true,
                message: 'WhatsApp déjà connecté',
                ...status
            });
        }
        if (!force && (status.initializing || status.state === 'connecting' || status.state === 'qr')) {
            return res.json({
                success: true,
                alreadyConnected: false,
                message: 'Connexion WhatsApp déjà en cours',
                ...status
            });
        }
        reconnectWhatsApp(force).catch((error) => {
            console.error('❌ Connexion WhatsApp:', error.message || error);
        });
        res.json({
            success: true,
            message: 'Génération du QR WhatsApp démarrée',
            ...getWhatsAppStatus()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livreurs', async (req, res) => {
    try {
        res.json(await dbUtils.getAllLivreurs());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livreurs/disponibles', async (req, res) => {
    try {
        res.json(await dbUtils.getLivreursDisponibles());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/commandes/en-attente', async (req, res) => {
    try {
        res.json(await dbUtils.getCommandesEnAttente());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/commandes/en-livraison', async (req, res) => {
    try {
        res.json(await dbUtils.getCommandesEnLivraison());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/commandes', async (req, res) => {
    try {
        const parsed = validateCommandeBody(req.body || {});
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const id = await dbUtils.createCommande(parsed.value);
        res.json({ id, message: 'Commande créée avec succès' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/assigner', async (req, res) => {
    try {
        const { commandeId, livreurId } = req.body;
        if (!commandeId || !livreurId) {
            return res.status(400).json({ error: 'commandeId et livreurId sont obligatoires' });
        }

        const commande = await dbUtils.getCommandeById(commandeId);
        if (!commande) return res.status(404).json({ error: 'Commande introuvable' });
        if (commande.statut !== 'EN_ATTENTE') {
            return res.status(400).json({ error: 'Cette commande n\'est plus en attente' });
        }

        const livreur = await dbUtils.getLivreurById(livreurId);
        if (!livreur) return res.status(404).json({ error: 'Livreur introuvable' });
        if (livreur.statut !== 'DISPONIBLE') {
            return res.status(400).json({ error: 'Ce livreur n\'est pas disponible' });
        }
        if (!livreur.whatsapp_id) {
            return res.status(400).json({ error: 'Ce livreur n\'a pas de WhatsApp configuré' });
        }

        await dbUtils.assignerCommande(commandeId, livreurId);
        const commandeAssignee = await dbUtils.getCommandeById(commandeId);

        try {
            await sendCommandeAuLivreur(livreur.whatsapp_id, commandeAssignee);
        } catch (waError) {
            // Rollback métier si WhatsApp échoue
            await dbUtils.remettreCommandeEnAttente(commandeId);
            await dbUtils.syncCommandesEnCours(livreurId);
            await dbUtils.addHistorique(livreurId, commandeId, 'ASSIGN_FAILED');
            return res.status(502).json({ error: `WhatsApp: ${waError.message}` });
        }

        res.json({ success: true, message: 'Commande assignée avec succès' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function prevenirLivreur(livreurId, texte) {
    if (!livreurId) return;
    try {
        const livreur = await dbUtils.getLivreurById(livreurId);
        if (livreur && livreur.whatsapp_id) {
            await sendMessage(livreur.whatsapp_id, texte);
        }
    } catch (error) {
        console.warn('WhatsApp livreur:', error.message);
    }
}

app.post('/api/commandes/:id/annuler', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const avant = await dbUtils.getCommandeById(id);
        const commande = await dbUtils.annulerCommande(id);
        if (avant && avant.livreur_id) {
            await prevenirLivreur(avant.livreur_id, `🚫 Commande ${avant.numero_local || 1} annulée par l'admin.`);
        }
        res.json({ success: true, commande });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/commandes/:id/forcer-livraison', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const commande = await dbUtils.forcerLivraison(id);
        res.json({ success: true, commande });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/commandes/:id/remettre-en-attente', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const commande = await dbUtils.getCommandeById(id);
        if (!commande) return res.status(404).json({ error: 'Commande introuvable' });
        if (!['ASSIGNEE', 'EN_LIVRAISON'].includes(commande.statut)) {
            return res.status(400).json({ error: 'Cette commande ne peut pas être remise en attente' });
        }
        const livreurId = commande.livreur_id;
        await dbUtils.remettreCommandeEnAttente(id);
        await dbUtils.addHistorique(livreurId, id, 'REMISE_EN_ATTENTE');
        if (livreurId) await dbUtils.syncCommandesEnCours(livreurId);
        await prevenirLivreur(livreurId, `↩️ Commande ${commande.numero_local || 1} remise en attente par l'admin.`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        res.json(await dbUtils.getStatsGenerales());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/historique', async (req, res) => {
    try {
        res.json(await dbUtils.getHistorique());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats/livreurs', async (req, res) => {
    try {
        res.json(await dbUtils.getStatsLivreurs());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livreurs/stats', async (req, res) => {
    try {
        res.json(await dbUtils.getAllLivreursAvecStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livreurs/:id/commandes', async (req, res) => {
    try {
        const livreurId = parseInt(req.params.id, 10);
        const livreur = await dbUtils.getLivreurById(livreurId);
        if (!livreur) return res.status(404).json({ error: 'Livreur introuvable' });
        const commandes = await dbUtils.getCommandesHistoriqueLivreur(livreurId);
        res.json({ livreur, commandes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function startTimeoutJob() {
    const tick = async () => {
        try {
            const liberees = await dbUtils.libererAssigneesExpirees(ASSIGN_TIMEOUT_MINUTES);
            if (!liberees.length) return;
            console.log(`⏱️ ${liberees.length} commande(s) ASSIGNEE expirée(s) remises en attente (>${ASSIGN_TIMEOUT_MINUTES} min)`);
            for (const commande of liberees) {
                await prevenirLivreur(
                    commande.livreur_id,
                    `⏱️ Commande ${commande.numero_local || 1} expirée : pas de réponse sous ${ASSIGN_TIMEOUT_MINUTES} min.\nElle a été remise en attente.`
                );
            }
        } catch (error) {
            console.error('Erreur timeout assignation:', error.message);
        }
    };
    await tick();
    setInterval(tick, 60 * 1000);
}

async function startServer() {
    const portInUse = await isPortInUse(PORT);
    if (portInUse) {
        console.error(`❌ Le port ${PORT} est déjà utilisé. Fermez l'ancien serveur Node avant de relancer.`);
        process.exit(1);
    }

    app.listen(PORT, () => {
        console.log(`🚀 Serveur admin démarré sur http://localhost:${PORT}`);
        if (ADMIN_API_KEY) console.log('🔐 Auth API activée (header x-api-key)');
        console.log(`⏱️ Timeout assignation: ${ASSIGN_TIMEOUT_MINUTES} min`);
        console.log('📱 WhatsApp en attente — cliquez sur « Générer le QR » dans l\'interface');
        startTimeoutJob();
    });
}

startServer();
