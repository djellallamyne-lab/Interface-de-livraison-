// frontend/script.js
const API_URL = window.location.origin.includes('localhost') || window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : window.location.origin;

let livreursDisponibles = [];
let commandesEnAttente = [];
let commandesSelectionnees = new Set();
let refreshTimer = null;

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

function toggleAccordion() {
    document.getElementById('accordionContent').classList.toggle('open');
    document.getElementById('accordionArrow').classList.toggle('open');
}

let waQrPoll = null;
let lastQrSrc = null;
let lastQrSig = null;

async function loadWhatsAppStatus() {
    const badge = document.getElementById('waStatusBadge');
    if (!badge) return null;
    try {
        const res = await fetch(`${API_URL}/api/whatsapp/status`, { headers: getApiHeaders() });
        const status = await res.json();
        badge.className = 'wa-badge ' + (status.state || 'disconnected');
        const labels = {
            ready: 'WhatsApp connecté',
            qr: 'QR à scanner',
            connecting: 'Connexion…',
            disconnected: 'WhatsApp déconnecté'
        };
        badge.textContent = labels[status.state] || 'WhatsApp';
        updateWaQrPopover(status);
        return status;
    } catch (_) {
        if (!lastQrSrc) {
            badge.className = 'wa-badge disconnected';
            badge.textContent = 'Serveur injoignable';
            updateWaQrPopover({
                state: 'disconnected',
                lastDisconnectReason: 'Serveur injoignable',
                qrDataUrl: null
            });
        }
        return null;
    }
}

function updateWaQrPopover(status) {
    const popover = document.getElementById('waQrPopover');
    if (!popover || popover.classList.contains('hidden')) return;

    const hint = document.getElementById('waQrHint');
    const loading = document.getElementById('waQrLoading');
    const image = document.getElementById('waQrImage');
    const errorEl = document.getElementById('waQrError');
    const refreshBtn = document.getElementById('waQrRefresh');

    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    if (refreshBtn) {
        refreshBtn.classList.remove('hidden');
        refreshBtn.disabled = Boolean(status.initializing);
        refreshBtn.textContent = status.qrDataUrl || status.state === 'connecting' || status.initializing
            ? 'Régénérer le QR'
            : status.state === 'ready'
                ? 'Reconnecter'
                : 'Générer le QR';
    }

    if (status.state === 'ready') {
        loading.classList.add('hidden');
        image.classList.add('hidden');
        lastQrSrc = null;
        lastQrSig = null;
        hint.textContent = 'WhatsApp est connecté.';
        stopWaQrPoll();
        return;
    }

    const qrSrc = status.qrDataUrl || lastQrSrc;
    if (qrSrc) {
        const sig = status.qrSig || lastQrSig;
        lastQrSrc = qrSrc;
        loading.classList.add('hidden');
        if (sig !== lastQrSig || !image.getAttribute('src')) {
            lastQrSig = sig;
            image.src = qrSrc;
        }
        image.classList.remove('hidden');
        hint.textContent = 'Scannez ce QR avec WhatsApp → Appareils connectés. Ne fermez pas la fenêtre.';
        return;
    }

    image.classList.add('hidden');
    loading.classList.remove('hidden');

    if (status.state === 'connecting' || status.initializing) {
        loading.textContent = 'Connexion WhatsApp…';
        hint.textContent = 'Vérification de la session en cours.';
    } else if (status.lastDisconnectReason) {
        loading.classList.add('hidden');
        errorEl.textContent = status.lastDisconnectReason;
        errorEl.classList.remove('hidden');
        hint.textContent = 'Réessayez avec « Générer le QR ».';
    } else {
        loading.textContent = 'En attente…';
        hint.textContent = 'Cliquez sur « Générer le QR » pour connecter WhatsApp';
    }
}

function ouvrirWaQrPopover() {
    const popover = document.getElementById('waQrPopover');
    const badge = document.getElementById('waStatusBadge');
    if (!popover || !badge) return;
    popover.classList.remove('hidden');
    badge.setAttribute('aria-expanded', 'true');
}

function fermerWaQrPopover() {
    const popover = document.getElementById('waQrPopover');
    const badge = document.getElementById('waStatusBadge');
    if (!popover || !badge) return;
    popover.classList.add('hidden');
    badge.setAttribute('aria-expanded', 'false');
}

function stopWaQrPoll() {
    if (waQrPoll) {
        clearInterval(waQrPoll);
        waQrPoll = null;
    }
}

function startWaQrPoll() {
    stopWaQrPoll();
    waQrPoll = setInterval(async () => {
        const s = await loadWhatsAppStatus();
        if (s && s.state === 'ready') stopWaQrPoll();
    }, 2000);
}

async function demarrerConnexionWhatsApp(force = false) {
    ouvrirWaQrPopover();

    const current = await loadWhatsAppStatus();
    if (!force && current && (
        current.state === 'ready'
        || current.state === 'connecting'
        || current.state === 'qr'
        || current.initializing
        || current.qrDataUrl
    )) {
        updateWaQrPopover(current);
        if (current.state !== 'ready') startWaQrPoll();
        return;
    }

    if (force) {
        lastQrSrc = null;
        lastQrSig = null;
    }
    updateWaQrPopover({ state: 'connecting', initializing: true, qrDataUrl: force ? null : lastQrSrc });

    try {
        await fetch(`${API_URL}/api/whatsapp/reconnect`, {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({ force: Boolean(force) })
        });
        startWaQrPoll();
    } catch (error) {
        updateWaQrPopover({
            state: 'disconnected',
            lastDisconnectReason: error.message || 'Erreur de connexion',
            qrDataUrl: lastQrSrc
        });
    }
}

function setupWhatsAppUi() {
    const badge = document.getElementById('waStatusBadge');
    const closeBtn = document.getElementById('waQrClose');
    const refreshBtn = document.getElementById('waQrRefresh');
    const popover = document.getElementById('waQrPopover');
    if (!badge || !popover) return;

    badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!popover.classList.contains('hidden')) {
            fermerWaQrPopover();
            return;
        }
        ouvrirWaQrPopover();
        const status = await loadWhatsAppStatus();
        if (status) {
            updateWaQrPopover(status);
            if (status.qrDataUrl || status.state === 'qr' || status.initializing) {
                startWaQrPoll();
            }
        } else {
            updateWaQrPopover({ state: 'disconnected', qrDataUrl: lastQrSrc });
        }
    });

    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        fermerWaQrPopover();
    });

    refreshBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await demarrerConnexionWhatsApp(Boolean(lastQrSrc));
    });

    document.addEventListener('click', (e) => {
        if (popover.classList.contains('hidden')) return;
        if (popover.contains(e.target) || badge.contains(e.target)) return;
        fermerWaQrPopover();
    });
}

setupWhatsAppUi();
loadData();
startAutoRefresh();

async function loadData() {
    try {
        const [tousLivreursRes, livreursRes, commandesRes, commandesLivraisonRes, statsRes, historiqueRes, statsLivreursRes] = await Promise.all([
            fetch(`${API_URL}/api/livreurs`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/livreurs/disponibles`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/commandes/en-attente`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/commandes/en-livraison`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/stats`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/historique`, { headers: getApiHeaders() }),
            fetch(`${API_URL}/api/stats/livreurs`, { headers: getApiHeaders() })
        ]);

        if ([tousLivreursRes, livreursRes, commandesRes].some(r => r.status === 401)) {
            console.warn('API protégée : définissez localStorage.ADMIN_API_KEY');
        }

        const tousLivreurs = await tousLivreursRes.json();
        const livreurs = await livreursRes.json();
        const commandes = await commandesRes.json();
        const commandesLivraison = await commandesLivraisonRes.json();
        const stats = await statsRes.json();
        const historique = await historiqueRes.json();
        const statsLivreurs = await statsLivreursRes.json();

        const availableIds = new Set((livreurs || []).map(l => Number(l.id)));
        const indisponibles = (tousLivreurs || []).filter(l => !availableIds.has(Number(l.id)));

        livreursDisponibles = livreurs;
        commandesEnAttente = commandes;

        displayLivreurs(livreurs);
        displayLivreursIndisponibles(indisponibles);
        displayCommandes(commandes);
        displayCommandesLivraison(commandesLivraison);
        displayStats(stats);
        displayHistorique(historique);
        displayStatsLivreurs(statsLivreurs);

        document.getElementById('nbDisponibles').textContent = livreurs.length;
        document.getElementById('nbIndisponibles').textContent = indisponibles.length;
        document.getElementById('nbEnAttente').textContent = commandes.length;
        document.getElementById('nbEnLivraison').textContent = commandesLivraison.length;
        document.getElementById('dispoCount').textContent = livreurs.length;
        document.getElementById('indispoCount').textContent = indisponibles.length;
        document.getElementById('attenteCount').textContent = commandes.length;
        document.getElementById('livraisonCount').textContent = commandesLivraison.length;
        document.getElementById('historiqueCount').textContent = historique ? historique.length : 0;

        await loadWhatsAppStatus();
    } catch (error) {
        console.error('Erreur:', error);
        await loadWhatsAppStatus();
    }
}

function displayLivreurs(livreurs) {
    const container = document.getElementById('livreursList');
    if (!livreurs || livreurs.length === 0) {
        container.innerHTML = `<div class="empty-message">Aucun livreur disponible</div>`;
        return;
    }
    container.innerHTML = livreurs.map(l => `
        <div class="livreur-card">
            <div class="info">
                <span class="nom">${escapeHtml(formatNomLivreur(l))}</span>
                <span class="details">${escapeHtml(formatPhone(l.numero_whatsapp))} · ${l.commandes_en_cours || 0} course(s)</span>
            </div>
        </div>
    `).join('');
}

function displayLivreursIndisponibles(livreurs) {
    const container = document.getElementById('livreursIndisponiblesList');
    if (!livreurs || livreurs.length === 0) {
        container.innerHTML = `<div class="empty-message">Aucun livreur indisponible</div>`;
        return;
    }
    container.innerHTML = livreurs.map(l => `
        <div class="livreur-card indisponible">
            <div class="info">
                <span class="nom">${escapeHtml(formatNomLivreur(l))}</span>
                <span class="details">${escapeHtml(formatPhone(l.numero_whatsapp))} · ${l.commandes_en_cours || 0} course(s)</span>
            </div>
        </div>
    `).join('');
}

function updateAssignerButton() {
    const btn = document.getElementById('btnAssignerSelection');
    if (!btn) return;
    const n = commandesSelectionnees.size;
    btn.disabled = n === 0;
    btn.textContent = n > 1 ? `Assigner (${n})` : 'Assigner';
}

function toggleCommandeSelection(id, event) {
    if (event && event.target.closest('button')) return;
    const numId = Number(id);
    if (commandesSelectionnees.has(numId)) commandesSelectionnees.delete(numId);
    else commandesSelectionnees.add(numId);
    const item = document.querySelector(`.commande-item[data-id="${numId}"]`);
    if (item) item.classList.toggle('selected', commandesSelectionnees.has(numId));
    updateAssignerButton();
}

function displayCommandes(commandes) {
    const container = document.getElementById('commandesList');
    const ids = new Set((commandes || []).map(c => c.id));
    commandesSelectionnees = new Set([...commandesSelectionnees].filter(id => ids.has(id)));
    updateAssignerButton();

    if (!commandes || commandes.length === 0) {
        container.innerHTML = `<div class="empty-message">Aucune commande en attente</div>`;
        return;
    }
    container.innerHTML = commandes.map(c => `
        <div class="commande-item commande-attente${commandesSelectionnees.has(c.id) ? ' selected' : ''}" data-id="${c.id}" onclick="toggleCommandeSelection(${c.id}, event)">
            <div class="header-commande">
                <span class="client">${escapeHtml(c.client_nom)}</span>
                <span class="commande-id">#${c.id}</span>
            </div>
            <div class="adresse">${escapeHtml(c.client_adresse)}</div>
            <div class="contenu">${escapeHtml(c.contenu)}</div>
            <div class="footer-commande">
                <span class="montant">${c.montant ? escapeHtml(c.montant) + ' €' : 'Montant —'}</span>
                <div class="commande-actions">
                    <button class="btn-danger-sm" onclick="annulerCommande(${c.id})">Annuler</button>
                </div>
            </div>
        </div>
    `).join('');
}

function displayCommandesLivraison(commandes) {
    const container = document.getElementById('commandesLivraisonList');
    if (!commandes || commandes.length === 0) {
        container.innerHTML = `<div class="empty-message">Aucune livraison en cours</div>`;
        return;
    }
    container.innerHTML = commandes.map(c => {
        const isAssignee = c.statut === 'ASSIGNEE';
        const statutLabel = isAssignee ? 'Assignée' : 'En livraison';
        const statutClass = isAssignee ? 'assignee' : 'livraison';
        const itemClass = isAssignee ? 'commande-assignee' : 'commande-livraison';
        return `
        <div class="commande-item ${itemClass}">
            <div class="header-commande">
                <span class="client">${escapeHtml(c.client_nom)}</span>
                <span class="commande-id">#${c.id}</span>
            </div>
            <div class="adresse">${escapeHtml(c.client_adresse)}</div>
            <div class="contenu">${escapeHtml(c.contenu)}</div>
            <div class="livreur-info">${escapeHtml(c.livreur_nom || 'Livreur inconnu')}</div>
            <div class="footer-commande">
                <span class="montant">${c.montant ? escapeHtml(c.montant) + ' €' : 'Montant —'}</span>
                <span class="statut-badge ${statutClass}">${statutLabel}</span>
            </div>
            <div class="commande-actions">
                <button class="btn-success-sm" onclick="forcerLivraison(${c.id})">Forcer livré</button>
                <button class="btn-warn-sm" onclick="remettreEnAttente(${c.id})">Remettre</button>
                <button class="btn-danger-sm" onclick="annulerCommande(${c.id})">Annuler</button>
            </div>
        </div>
    `}).join('');
}

function displayStats(stats) {
    if (!stats || stats.error) return;
    document.getElementById('statTotal').textContent = stats.total || 0;
    document.getElementById('statAcceptees').textContent = stats.acceptees || 0;
    document.getElementById('statRefusees').textContent = stats.refusees || 0;
    document.getElementById('statEnAttente').textContent = stats.enAttente || 0;
    document.getElementById('statMeilleurLivreur').textContent = stats.meilleurLivreur || '-';
    document.getElementById('statTauxAcceptation').textContent = stats.tauxAcceptation || '0%';
}

function displayStatsLivreurs(statsLivreurs) {
    const container = document.getElementById('statsLivreursList');
    if (!statsLivreurs || statsLivreurs.length === 0 || statsLivreurs.error) {
        container.innerHTML = `<div class="empty-message">Aucune donnée</div>`;
        return;
    }
    container.innerHTML = statsLivreurs.map(s => {
        let tauxClass = 'low';
        if (s.taux >= 70) tauxClass = 'high';
        else if (s.taux >= 40) tauxClass = 'medium';
        return `
            <div class="stat-livreur-item">
                <div class="sl-info">
                    <span class="sl-nom">${escapeHtml(formatNomLivreur(s))}</span>
                    <span class="sl-detail">${s.total} assignation(s)</span>
                </div>
                <span class="sl-taux ${tauxClass}">${s.taux || 0}%</span>
            </div>
        `;
    }).join('');
}

function displayHistorique(historique) {
    const container = document.getElementById('historiqueList');
    if (!historique || historique.length === 0 || historique.error) {
        container.innerHTML = `<div class="empty-message">Aucune activité</div>`;
        return;
    }
    container.innerHTML = historique.map(h => {
        let statutClass = 'en-attente';
        let statutText = h.statut || 'EN_ATTENTE';
        switch (statutText) {
            case 'ACCEPTEE':
            case 'EN_LIVRAISON':
                statutClass = 'accepte';
                statutText = 'ACCEPTÉE';
                break;
            case 'REFUSEE':
                statutClass = 'refuse';
                statutText = 'REFUSÉE';
                break;
            case 'LIVREE':
                statutClass = 'livree';
                statutText = 'LIVRÉE';
                break;
            case 'TIMEOUT':
                statutClass = 'en-attente';
                statutText = 'TIMEOUT';
                break;
            case 'ANNULEE':
                statutClass = 'refuse';
                statutText = 'ANNULÉE';
                break;
            case 'ASSIGNEE':
                statutClass = 'accepte';
                statutText = 'ASSIGNÉE';
                break;
            default:
                statutClass = 'en-attente';
                statutText = statutText.replace(/_/g, ' ');
        }
        return `
            <div class="historique-item">
                <div>
                    <span class="h-client">${escapeHtml(h.client_nom || '—')}</span>
                    <span class="h-livreur"> → ${escapeHtml(h.livreur_nom || 'Non assigné')}</span>
                </div>
                <div class="h-right">
                    <span class="h-statut ${statutClass}">${escapeHtml(statutText)}</span>
                    <span class="h-date">${h.date_creation ? new Date(h.date_creation).toLocaleDateString() + ' ' + new Date(h.date_creation).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</span>
                </div>
            </div>
        `;
    }).join('');
}

function ouvrirModalAssignation() {
    const ids = [...commandesSelectionnees];
    if (ids.length === 0) return;

    const commandes = ids
        .map(id => commandesEnAttente.find(c => c.id === id))
        .filter(Boolean);
    if (commandes.length === 0) return;

    const modal = document.getElementById('assignModal');
    const select = document.getElementById('livreurSelect');
    const errorEl = document.getElementById('modalError');
    const title = document.getElementById('modalAssignTitle');

    title.textContent = commandes.length > 1
        ? `Assigner ${commandes.length} commandes`
        : 'Assigner la commande';
    document.getElementById('modalCommandeInfo').textContent = commandes
        .map(c => `#${c.id} — ${c.client_nom}`)
        .join('\n');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    select.innerHTML = '<option value="">-- Sélectionner un livreur --</option>';
    if (!livreursDisponibles || livreursDisponibles.length === 0) {
        select.innerHTML = '<option value="">Aucun livreur disponible</option>';
        select.disabled = true;
    } else {
        select.disabled = false;
        livreursDisponibles.forEach(l => {
            const option = document.createElement('option');
            option.value = l.id;
            option.textContent = `${formatNomLivreur(l)} (${l.commandes_en_cours || 0} commande(s))`;
            select.appendChild(option);
        });
    }

    modal.classList.remove('hidden');
}

function fermerModalAssignation() {
    document.getElementById('assignModal').classList.add('hidden');
    document.getElementById('livreurSelect').value = '';
}

async function confirmerAssignation() {
    const livreurId = document.getElementById('livreurSelect').value;
    const errorEl = document.getElementById('modalError');
    const ids = [...commandesSelectionnees];
    if (ids.length === 0) return;

    if (!livreurId) {
        errorEl.textContent = '⚠️ Veuillez sélectionner un livreur.';
        errorEl.classList.remove('hidden');
        return;
    }

    const parsedLivreurId = parseInt(livreurId, 10);
    const erreurs = [];

    try {
        for (const commandeId of ids) {
            const response = await fetch(`${API_URL}/api/assigner`, {
                method: 'POST',
                headers: getApiHeaders(),
                body: JSON.stringify({ commandeId, livreurId: parsedLivreurId })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                erreurs.push(`#${commandeId}: ${err.error || 'Erreur'}`);
            } else {
                commandesSelectionnees.delete(commandeId);
            }
        }

        if (erreurs.length) {
            errorEl.textContent = `❌ ${erreurs.join(' · ')}`;
            errorEl.classList.remove('hidden');
            updateAssignerButton();
            return;
        }

        fermerModalAssignation();
        loadData();
    } catch (error) {
        console.error('Erreur:', error);
        errorEl.textContent = '❌ Erreur lors de l\'assignation';
        errorEl.classList.remove('hidden');
    }
}

async function annulerCommande(id) {
    if (!confirm(`Annuler la commande #${id} ?`)) return;
    try {
        const res = await fetch(`${API_URL}/api/commandes/${id}/annuler`, {
            method: 'POST',
            headers: getApiHeaders()
        });
        if (!res.ok) {
            const err = await res.json();
            alert(err.error || 'Erreur');
            return;
        }
        loadData();
    } catch (e) {
        alert('Erreur lors de l\'annulation');
    }
}

async function forcerLivraison(id) {
    if (!confirm(`Forcer la livraison de la commande #${id} ?`)) return;
    try {
        const res = await fetch(`${API_URL}/api/commandes/${id}/forcer-livraison`, {
            method: 'POST',
            headers: getApiHeaders()
        });
        if (!res.ok) {
            const err = await res.json();
            alert(err.error || 'Erreur');
            return;
        }
        loadData();
    } catch (e) {
        alert('Erreur lors de la validation');
    }
}

async function remettreEnAttente(id) {
    if (!confirm(`Remettre la commande #${id} en attente ?`)) return;
    try {
        const res = await fetch(`${API_URL}/api/commandes/${id}/remettre-en-attente`, {
            method: 'POST',
            headers: getApiHeaders()
        });
        if (!res.ok) {
            const err = await res.json();
            alert(err.error || 'Erreur');
            return;
        }
        loadData();
    } catch (e) {
        alert('Erreur');
    }
}

document.getElementById('assignModal').addEventListener('click', (e) => {
    if (e.target.id === 'assignModal') fermerModalAssignation();
});

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

document.getElementById('commandeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = {
        client_nom: document.getElementById('clientNom').value.trim(),
        client_adresse: document.getElementById('clientAdresse').value.trim(),
        client_telephone: document.getElementById('clientTelephone').value.trim() || null,
        contenu: document.getElementById('contenu').value.trim(),
        montant: document.getElementById('montant').value || null
    };
    if (!formData.client_nom || !formData.client_adresse || !formData.contenu) {
        alert('⚠️ Remplissez tous les champs obligatoires !');
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/commandes`, {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(formData)
        });
        if (response.ok) {
            document.getElementById('commandeForm').reset();
            loadData();
        } else {
            const err = await response.json();
            alert(`❌ Erreur: ${err.error || 'Erreur inconnue'}`);
        }
    } catch (error) {
        console.error('Erreur:', error);
        alert('❌ Erreur lors de l\'ajout');
    }
});

function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadData, 5000);
}
