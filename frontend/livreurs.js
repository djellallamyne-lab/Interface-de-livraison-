const API_URL = window.location.origin.includes('localhost') || window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : window.location.origin;

let livreurSelectionne = null;

function getApiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const key = localStorage.getItem('ADMIN_API_KEY');
    if (key) headers['x-api-key'] = key;
    return headers;
}

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNomLivreur(personne) {
    const prenom = String((personne && personne.prenom) || '').trim();
    const nom = String((personne && personne.nom) || '').trim();
    return [prenom || 'Livreur', nom].filter(Boolean).join(' ');
}

async function loadLivreurs() {
    try {
        const res = await fetch(`${API_URL}/api/livreurs/stats`, { headers: getApiHeaders() });
        const livreurs = await res.json();
        displayLivreursStats(livreurs);
    } catch (error) {
        console.error('Erreur:', error);
        document.getElementById('livreursStatsList').innerHTML =
            '<div class="empty-message">❌ Erreur de chargement</div>';
    }
}

function displayLivreursStats(livreurs) {
    const container = document.getElementById('livreursStatsList');
    if (!livreurs || livreurs.length === 0 || livreurs.error) {
        container.innerHTML = '<div class="empty-message">📭 Aucun livreur inscrit</div>';
        return;
    }

    container.innerHTML = livreurs.map(l => {
        const isActive = livreurSelectionne === l.id ? 'active' : '';
        const statutIcon = l.statut === 'DISPONIBLE' ? '●' : '○';
        return `
            <button class="livreur-stat-item ${isActive}" onclick="selectionnerLivreur(${l.id})">
                <div class="ls-main">
                    <span class="ls-nom">${statutIcon} ${escapeHtml(formatNomLivreur(l))}</span>
                    <span class="ls-phone">${escapeHtml(formatPhone(l.numero_whatsapp))}</span>
                </div>
                <div class="ls-stats">
                    <span class="ls-stat" title="Total assignées">${l.total || 0} total</span>
                    <span class="ls-stat livree" title="Livrées">${l.livrees || 0} livrées</span>
                    <span class="ls-stat cours" title="En cours">${l.en_cours || 0} en cours</span>
                    <span class="ls-stat refusee" title="Refusées">${l.refusees || 0} refus</span>
                </div>
            </button>
        `;
    }).join('');
}

async function selectionnerLivreur(livreurId) {
    livreurSelectionne = livreurId;
    loadLivreurs();

    const header = document.getElementById('livreurDetailHeader');
    const container = document.getElementById('livreurCommandesList');
    container.innerHTML = '<div class="empty-message">⏳ Chargement...</div>';

    try {
        const res = await fetch(`${API_URL}/api/livreurs/${livreurId}/commandes`, { headers: getApiHeaders() });
        if (!res.ok) throw new Error('Livreur introuvable');
        const data = await res.json();
        const { livreur, commandes } = data;

        header.innerHTML = `
            <h2>${escapeHtml(formatNomLivreur(livreur))}</h2>
            <p class="detail-subtitle">
                ${escapeHtml(formatPhone(livreur.numero_whatsapp))} ·
                ${livreur.statut === 'DISPONIBLE' ? 'Disponible' : 'Indisponible'} ·
                <span class="badge">${commandes.length} commande(s)</span>
            </p>
        `;

        displayCommandesLivreur(commandes);
    } catch (error) {
        console.error('Erreur:', error);
        container.innerHTML = '<div class="empty-message">❌ Erreur de chargement</div>';
    }
}

function displayCommandesLivreur(commandes) {
    const container = document.getElementById('livreurCommandesList');
    if (!commandes || commandes.length === 0) {
        container.innerHTML = '<div class="empty-message">📭 Aucune commande assignée à ce livreur</div>';
        return;
    }

    container.innerHTML = commandes.map(c => {
        const statut = formatStatut(c.statut, c.derniere_action);
        return `
            <div class="commande-detail-card statut-${statut.class}">
                <div class="cdc-header">
                    <span class="cdc-id">Commande #${c.id}</span>
                    <span class="cdc-statut ${statut.class}">${statut.label}</span>
                </div>
                <div class="cdc-grid">
                    <div class="cdc-field">
                        <span class="cdc-label">Client</span>
                        <span class="cdc-value">${escapeHtml(c.client_nom)}</span>
                    </div>
                    <div class="cdc-field">
                        <span class="cdc-label">Adresse</span>
                        <span class="cdc-value">${escapeHtml(c.client_adresse)}</span>
                    </div>
                    <div class="cdc-field">
                        <span class="cdc-label">Téléphone</span>
                        <span class="cdc-value">${escapeHtml(c.client_telephone || 'Non fourni')}</span>
                    </div>
                    <div class="cdc-field">
                        <span class="cdc-label">Montant</span>
                        <span class="cdc-value">${c.montant ? escapeHtml(c.montant) + ' €' : 'Non spécifié'}</span>
                    </div>
                    <div class="cdc-field full">
                        <span class="cdc-label">Contenu</span>
                        <span class="cdc-value">${escapeHtml(c.contenu)}</span>
                    </div>
                    <div class="cdc-field">
                        <span class="cdc-label">Créée le</span>
                        <span class="cdc-value">${formatDateTime(c.date_creation)}</span>
                    </div>
                    <div class="cdc-field">
                        <span class="cdc-label">Livrée le</span>
                        <span class="cdc-value">${c.date_livraison ? formatDateTime(c.date_livraison) : '—'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function formatStatut(statut, derniereAction) {
    if (derniereAction === 'REFUSEE' && statut === 'EN_ATTENTE') {
        return { label: 'Refusée (repassée)', class: 'refusee' };
    }
    if (derniereAction === 'REFUSEE' && !['ASSIGNEE', 'EN_LIVRAISON', 'LIVREE'].includes(statut)) {
        return { label: 'Refusée', class: 'refusee' };
    }
    switch (statut) {
        case 'ASSIGNEE':
            return { label: 'Assignée', class: 'assignee' };
        case 'EN_LIVRAISON':
        case 'ACCEPTEE':
            return { label: 'En livraison', class: 'livraison' };
        case 'LIVREE':
            return { label: 'Livrée', class: 'livree' };
        case 'REFUSEE':
            return { label: 'Refusée', class: 'refusee' };
        case 'ANNULEE':
            return { label: 'Annulée', class: 'refusee' };
        default:
            return { label: statut || 'Inconnu', class: 'en-attente' };
    }
}

function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }) + ' à ' + d.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatPhone(phone) {
    if (!phone) return 'Numéro inconnu';
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) return 'Numéro inconnu';
    if (digits.length > 12) return 'Numéro à confirmer';
    let local = digits;
    if (local.startsWith('33') && local.length === 11) local = '0' + local.slice(2);
    if (/^0\d{9}$/.test(local)) {
        return local.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
    }
    return String(phone);
}

loadLivreurs();
setInterval(loadLivreurs, 10000);
