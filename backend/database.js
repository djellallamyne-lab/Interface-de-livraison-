// backend/database.js
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, '../database.sqlite'));

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS livreurs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_whatsapp TEXT UNIQUE NOT NULL,
            whatsapp_id TEXT,
            prenom TEXT,
            nom TEXT,
            statut TEXT DEFAULT 'INDISPONIBLE',
            max_commandes INTEGER DEFAULT 3,
            commandes_en_cours INTEGER DEFAULT 0,
            date_inscription DATETIME DEFAULT CURRENT_TIMESTAMP,
            derniere_activite DATETIME
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS commandes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_uber TEXT,
            client_nom TEXT NOT NULL,
            client_adresse TEXT NOT NULL,
            client_telephone TEXT,
            contenu TEXT NOT NULL,
            montant DECIMAL(10,2),
            statut TEXT DEFAULT 'EN_ATTENTE',
            date_creation DATETIME DEFAULT CURRENT_TIMESTAMP,
            date_livraison DATETIME,
            livreur_id INTEGER,
            FOREIGN KEY (livreur_id) REFERENCES livreurs(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS historique (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            livreur_id INTEGER,
            commande_id INTEGER,
            action TEXT,
            date_action DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (livreur_id) REFERENCES livreurs(id),
            FOREIGN KEY (commande_id) REFERENCES commandes(id)
        )
    `);

    db.run('ALTER TABLE commandes ADD COLUMN numero_local INTEGER', () => {
        /* colonne déjà présente */
    });
});

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function withTransaction(fn) {
    await run('BEGIN IMMEDIATE');
    try {
        const result = await fn();
        await run('COMMIT');
        return result;
    } catch (error) {
        try {
            await run('ROLLBACK');
        } catch (_) {
            /* ignore rollback errors */
        }
        throw error;
    }
}

const dbUtils = {
    getLivreurByNumero: async (numero) => {
        const raw = String(numero || '').trim();
        if (!raw) return undefined;
        const exact = await get('SELECT * FROM livreurs WHERE numero_whatsapp = ?', [raw]);
        if (exact) return exact;

        const digits = raw.replace(/\D/g, '');
        if (!digits) return undefined;
        const variants = new Set([digits]);
        if (digits.startsWith('33') && digits.length > 10) variants.add('0' + digits.slice(2));
        if (digits.startsWith('0') && digits.length === 10) variants.add('33' + digits.slice(1));
        const rows = await all('SELECT * FROM livreurs');
        return rows.find((l) => {
            const stored = String(l.numero_whatsapp || '').replace(/\D/g, '');
            return variants.has(stored);
        });
    },

    createLivreur: async (numero, prenom, nom, whatsappId = null) => {
        const result = await run(
            'INSERT INTO livreurs (numero_whatsapp, prenom, nom, whatsapp_id) VALUES (?, ?, ?, ?)',
            [numero, prenom, nom, whatsappId]
        );
        return result.lastID;
    },

    updateLivreurStatut: (numero, statut) => run(
        'UPDATE livreurs SET statut = ?, derniere_activite = CURRENT_TIMESTAMP WHERE numero_whatsapp = ?',
        [statut, numero]
    ),

    getLivreurByWhatsAppId: (whatsappId) => get(
        'SELECT * FROM livreurs WHERE whatsapp_id = ?',
        [whatsappId]
    ),

    updateLivreurNumero: (id, numero) => run(
        'UPDATE livreurs SET numero_whatsapp = ? WHERE id = ?',
        [numero, id]
    ),

    updateLivreurWhatsAppId: (numero, whatsappId) => run(
        'UPDATE livreurs SET whatsapp_id = ? WHERE numero_whatsapp = ?',
        [whatsappId, numero]
    ),

    updateLivreurWhatsAppIdById: (id, whatsappId) => run(
        'UPDATE livreurs SET whatsapp_id = ? WHERE id = ?',
        [whatsappId, id]
    ),

    getLivreursDisponibles: () => all(
        `SELECT * FROM livreurs
         WHERE statut = "DISPONIBLE"
         ORDER BY id ASC`
    ),

    getLivreurById: (id) => get('SELECT * FROM livreurs WHERE id = ?', [id]),

    getAllLivreurs: () => all(
        'SELECT * FROM livreurs ORDER BY date_inscription DESC'
    ),

    createCommande: async (commande) => {
        const { numero_uber, client_nom, client_adresse, client_telephone, contenu, montant } = commande;
        const result = await run(
            `INSERT INTO commandes (numero_uber, client_nom, client_adresse, client_telephone, contenu, montant)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [numero_uber, client_nom, client_adresse, client_telephone, contenu, montant]
        );
        return result.lastID;
    },

    getCommandeById: (id) => get('SELECT * FROM commandes WHERE id = ?', [id]),

    getCommandesEnAttente: () => all(
        'SELECT * FROM commandes WHERE statut = "EN_ATTENTE" ORDER BY date_creation ASC'
    ),

    getCommandesEnLivraison: () => all(
        `SELECT c.*, TRIM(l.prenom || ' ' || COALESCE(l.nom, '')) as livreur_nom
         FROM commandes c
         LEFT JOIN livreurs l ON l.id = c.livreur_id
         WHERE c.statut IN ('ASSIGNEE', 'EN_LIVRAISON')
         ORDER BY c.date_creation ASC`
    ),

    getCommandesByLivreur: (livreurId) => all(
        'SELECT * FROM commandes WHERE livreur_id = ? AND statut IN ("ASSIGNEE", "EN_LIVRAISON")',
        [livreurId]
    ),

    syncCommandesEnCours: async (livreurId) => {
        const row = await get(
            `SELECT COUNT(*) as n FROM commandes
             WHERE livreur_id = ? AND statut IN ('ASSIGNEE', 'EN_LIVRAISON')`,
            [livreurId]
        );
        const n = row ? row.n : 0;
        await run('UPDATE livreurs SET commandes_en_cours = ? WHERE id = ?', [n, livreurId]);
        return n;
    },

    assignerCommande: (commandeId, livreurId) => withTransaction(async () => {
        const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);
        if (!commande) throw new Error('Commande introuvable');
        if (commande.statut !== 'EN_ATTENTE') throw new Error('Cette commande n\'est plus en attente');

        const row = await get(
            `SELECT COUNT(*) as n, MAX(numero_local) as maxn
             FROM commandes
             WHERE livreur_id = ? AND statut IN ('ASSIGNEE', 'EN_LIVRAISON')`,
            [livreurId]
        );
        const numeroLocal = (!row || !row.n) ? 1 : (Number(row.maxn) || 0) + 1;

        await run(
            'UPDATE commandes SET livreur_id = ?, statut = "ASSIGNEE", numero_local = ? WHERE id = ?',
            [livreurId, numeroLocal, commandeId]
        );
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, 'ASSIGNEE']
        );
        await dbUtils.syncCommandesEnCours(livreurId);
    }),

    addHistorique: async (livreurId, commandeId, action) => {
        const result = await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, action]
        );
        return result.lastID;
    },

    incrementCommandesEnCours: (livreurId) => dbUtils.syncCommandesEnCours(livreurId),
    decrementCommandesEnCours: (livreurId) => dbUtils.syncCommandesEnCours(livreurId),

    updateCommandeStatut: (commandeId, statut) => run(
        'UPDATE commandes SET statut = ? WHERE id = ?',
        [statut, commandeId]
    ),

    getCommandesAssignees: (livreurId) => all(
        `SELECT * FROM commandes
         WHERE livreur_id = ? AND statut = 'ASSIGNEE'
         ORDER BY numero_local ASC, date_creation ASC`,
        [livreurId]
    ),

    getCommandesEnLivraisonActives: (livreurId) => all(
        `SELECT * FROM commandes
         WHERE livreur_id = ? AND statut = 'EN_LIVRAISON'
         ORDER BY numero_local ASC, date_creation ASC`,
        [livreurId]
    ),

    getCommandeByLivreurAndId: (livreurId, commandeId, statuts) => {
        const placeholders = statuts.map(() => '?').join(', ');
        return get(
            `SELECT * FROM commandes
             WHERE id = ? AND livreur_id = ? AND statut IN (${placeholders})`,
            [commandeId, livreurId, ...statuts]
        );
    },

    getCommandeByNumeroLocal: (livreurId, numeroLocal, statuts) => {
        const placeholders = statuts.map(() => '?').join(', ');
        return get(
            `SELECT * FROM commandes
             WHERE livreur_id = ? AND numero_local = ? AND statut IN (${placeholders})`,
            [livreurId, numeroLocal, ...statuts]
        );
    },

    accepterCommande: (commandeId, livreurId) => withTransaction(async () => {
        const commande = await get(
            `SELECT * FROM commandes WHERE id = ? AND livreur_id = ? AND statut = 'ASSIGNEE'`,
            [commandeId, livreurId]
        );
        if (!commande) throw new Error('Commande introuvable ou déjà traitée');
        await run(`UPDATE commandes SET statut = 'EN_LIVRAISON' WHERE id = ?`, [commandeId]);
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, 'ACCEPTEE']
        );
        await dbUtils.syncCommandesEnCours(livreurId);
        return commande;
    }),

    refuserCommande: (commandeId, livreurId) => withTransaction(async () => {
        const commande = await get(
            `SELECT * FROM commandes WHERE id = ? AND livreur_id = ? AND statut = 'ASSIGNEE'`,
            [commandeId, livreurId]
        );
        if (!commande) throw new Error('Commande introuvable ou déjà traitée');
        await run(
            `UPDATE commandes SET statut = 'EN_ATTENTE', livreur_id = NULL, numero_local = NULL WHERE id = ?`,
            [commandeId]
        );
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, 'REFUSEE']
        );
        await dbUtils.syncCommandesEnCours(livreurId);
        return commande;
    }),

    livrerCommande: (commandeId, livreurId) => withTransaction(async () => {
        const commande = await get(
            `SELECT * FROM commandes WHERE id = ? AND livreur_id = ? AND statut = 'EN_LIVRAISON'`,
            [commandeId, livreurId]
        );
        if (!commande) throw new Error('Commande introuvable ou déjà traitée');
        await run(
            `UPDATE commandes SET statut = 'LIVREE', date_livraison = CURRENT_TIMESTAMP, numero_local = NULL WHERE id = ?`,
            [commandeId]
        );
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, 'LIVREE']
        );
        await dbUtils.syncCommandesEnCours(livreurId);
        return commande;
    }),

    remettreCommandeEnAttente: (commandeId) => run(
        `UPDATE commandes SET statut = 'EN_ATTENTE', livreur_id = NULL, numero_local = NULL WHERE id = ?`,
        [commandeId]
    ),

    marquerCommandeLivree: (commandeId) => run(
        `UPDATE commandes SET statut = 'LIVREE', date_livraison = CURRENT_TIMESTAMP, numero_local = NULL WHERE id = ?`,
        [commandeId]
    ),

    annulerCommande: (commandeId) => withTransaction(async () => {
        const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);
        if (!commande) throw new Error('Commande introuvable');
        if (!['EN_ATTENTE', 'ASSIGNEE', 'EN_LIVRAISON'].includes(commande.statut)) {
            throw new Error('Cette commande ne peut plus être annulée');
        }
        const livreurId = commande.livreur_id;
        await run(`UPDATE commandes SET statut = 'ANNULEE', numero_local = NULL WHERE id = ?`, [commandeId]);
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [livreurId, commandeId, 'ANNULEE']
        );
        if (livreurId) await dbUtils.syncCommandesEnCours(livreurId);
        return commande;
    }),

    forcerLivraison: (commandeId) => withTransaction(async () => {
        const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);
        if (!commande) throw new Error('Commande introuvable');
        if (!['ASSIGNEE', 'EN_LIVRAISON'].includes(commande.statut)) {
            throw new Error('Cette commande n\'est pas en cours');
        }
        await run(
            `UPDATE commandes SET statut = 'LIVREE', date_livraison = CURRENT_TIMESTAMP, numero_local = NULL WHERE id = ?`,
            [commandeId]
        );
        await run(
            'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
            [commande.livreur_id, commandeId, 'LIVREE']
        );
        if (commande.livreur_id) await dbUtils.syncCommandesEnCours(commande.livreur_id);
        return commande;
    }),

    libererAssigneesExpirees: async (minutes = 15) => {
        const rows = await all(
            `SELECT c.* FROM commandes c
             WHERE c.statut = 'ASSIGNEE'
               AND COALESCE(
                   (
                       SELECT h.date_action FROM historique h
                       WHERE h.commande_id = c.id AND h.action = 'ASSIGNEE'
                       ORDER BY h.date_action DESC LIMIT 1
                   ),
                   c.date_creation
               ) <= datetime('now', ?)`,
            [`-${Number(minutes) || 15} minutes`]
        );
        const liberees = [];
        for (const commande of rows) {
            const changed = await withTransaction(async () => {
                const result = await run(
                    `UPDATE commandes SET statut = 'EN_ATTENTE', livreur_id = NULL, numero_local = NULL WHERE id = ? AND statut = 'ASSIGNEE'`,
                    [commande.id]
                );
                if (!result.changes) return false;
                await run(
                    'INSERT INTO historique (livreur_id, commande_id, action) VALUES (?, ?, ?)',
                    [commande.livreur_id, commande.id, 'TIMEOUT']
                );
                if (commande.livreur_id) await dbUtils.syncCommandesEnCours(commande.livreur_id);
                return true;
            });
            if (changed) liberees.push(commande);
        }
        return liberees;
    },

    getStatsLivreurs: () => all(`
        SELECT
            l.id,
            l.prenom,
            l.nom,
            (SELECT COUNT(DISTINCT commande_id) FROM historique h WHERE h.livreur_id = l.id AND h.action = 'ASSIGNEE') as total,
            ROUND(
                CASE
                    WHEN (SELECT COUNT(*) FROM historique h WHERE h.livreur_id = l.id AND h.action = 'ASSIGNEE') = 0 THEN 0
                    ELSE (
                        SELECT COUNT(*) FROM historique h2
                        WHERE h2.livreur_id = l.id AND h2.action IN ('ACCEPTEE', 'LIVREE')
                    ) * 100.0 / (
                        SELECT COUNT(*) FROM historique h3
                        WHERE h3.livreur_id = l.id AND h3.action = 'ASSIGNEE'
                    )
                END,
                0
            ) as taux
        FROM livreurs l
        WHERE EXISTS (SELECT 1 FROM historique h WHERE h.livreur_id = l.id)
        ORDER BY total DESC
    `),

    getAllLivreursAvecStats: () => all(`
        SELECT
            l.id,
            l.prenom,
            l.nom,
            l.statut,
            l.numero_whatsapp,
            l.date_inscription,
            (SELECT COUNT(DISTINCT commande_id) FROM historique h WHERE h.livreur_id = l.id AND h.action = 'ASSIGNEE') as total,
            (SELECT COUNT(*) FROM historique h WHERE h.livreur_id = l.id AND h.action = 'LIVREE') as livrees,
            (SELECT COUNT(*) FROM commandes c WHERE c.livreur_id = l.id AND c.statut IN ('ASSIGNEE', 'EN_LIVRAISON')) as en_cours,
            (SELECT COUNT(*) FROM historique h WHERE h.livreur_id = l.id AND h.action = 'REFUSEE') as refusees
        FROM livreurs l
        ORDER BY total DESC, l.prenom ASC
    `),

    getCommandesHistoriqueLivreur: (livreurId) => all(
        `SELECT c.*,
            (SELECT h.action FROM historique h
             WHERE h.commande_id = c.id AND h.livreur_id = ?
             ORDER BY h.date_action DESC LIMIT 1) as derniere_action
         FROM commandes c
         WHERE c.livreur_id = ?
            OR c.id IN (SELECT commande_id FROM historique WHERE livreur_id = ?)
         ORDER BY c.date_creation DESC`,
        [livreurId, livreurId, livreurId]
    ),

    getStatsGenerales: async () => {
        const row = await get(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN statut IN ('EN_LIVRAISON', 'LIVREE') THEN 1 ELSE 0 END) as acceptees,
                SUM(CASE WHEN statut = 'EN_ATTENTE' THEN 1 ELSE 0 END) as enAttente
            FROM commandes
            WHERE statut != 'ANNULEE'
        `);
        const refusRow = await get(
            `SELECT COUNT(*) as refusees FROM historique WHERE action = 'REFUSEE'`
        );
        const meilleur = await get(`
            SELECT TRIM(l.prenom || ' ' || COALESCE(l.nom, '')) as nom
            FROM livreurs l
            JOIN historique h ON h.livreur_id = l.id AND h.action = 'LIVREE'
            GROUP BY l.id
            ORDER BY COUNT(h.id) DESC
            LIMIT 1
        `);

        const total = (row && row.total) || 0;
        const acceptees = (row && row.acceptees) || 0;
        const refusees = (refusRow && refusRow.refusees) || 0;
        const enAttente = (row && row.enAttente) || 0;
        const denom = acceptees + refusees;
        const taux = denom > 0 ? Math.round(acceptees * 100 / denom) + '%' : '0%';

        return {
            total,
            acceptees,
            refusees,
            enAttente,
            meilleurLivreur: meilleur ? meilleur.nom : '-',
            tauxAcceptation: taux
        };
    },

    getHistorique: () => all(`
        SELECT
            h.id,
            h.action as statut,
            h.date_action as date_creation,
            c.client_nom,
            TRIM(l.prenom || ' ' || COALESCE(l.nom, '')) as livreur_nom
        FROM historique h
        LEFT JOIN commandes c ON c.id = h.commande_id
        LEFT JOIN livreurs l ON l.id = h.livreur_id
        ORDER BY h.date_action DESC
        LIMIT 100
    `)
};

module.exports = { db, dbUtils, withTransaction };
