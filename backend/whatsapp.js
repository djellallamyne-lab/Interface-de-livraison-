// backend/whatsapp.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { dbUtils } = require('./database');

let client = null;
let initializing = false;
let clientReadyAt = 0;
const sessions = new Map();
const seenMessageIds = new Map();
const chatQueues = new Map();

const crypto = require('crypto');

function qrSignature(qr) {
    return crypto.createHash('sha1').update(String(qr)).digest('hex').slice(0, 12);
}

const whatsappStatus = {
    state: 'disconnected', // disconnected | qr | connecting | ready
    lastQrAt: null,
    lastReadyAt: null,
    lastDisconnectReason: null,
    qr: null,
    qrSig: null,
    qrDataUrl: null,
    qrCount: 0
};

function getWhatsAppStatus() {
    return {
        state: whatsappStatus.state,
        lastQrAt: whatsappStatus.lastQrAt,
        lastReadyAt: whatsappStatus.lastReadyAt,
        lastDisconnectReason: whatsappStatus.lastDisconnectReason,
        ready: whatsappStatus.state === 'ready',
        hasQr: Boolean(whatsappStatus.qrDataUrl),
        qrDataUrl: whatsappStatus.qrDataUrl,
        qrSig: whatsappStatus.qrSig,
        qrCount: whatsappStatus.qrCount,
        initializing
    };
}

async function setQr(qr) {
    const sig = qrSignature(qr);
    if (whatsappStatus.qrSig === sig && whatsappStatus.qrDataUrl) {
        whatsappStatus.state = 'qr';
        return;
    }

    const isRefresh = Boolean(whatsappStatus.qrDataUrl);
    whatsappStatus.state = 'qr';
    whatsappStatus.lastQrAt = new Date().toISOString();
    whatsappStatus.qr = qr;
    whatsappStatus.qrSig = sig;
    whatsappStatus.qrCount += 1;

    try {
        whatsappStatus.qrDataUrl = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280,
            color: { dark: '#1a1208', light: '#ffffff' }
        });
    } catch (error) {
        console.error('Erreur génération QR image:', error.message);
        whatsappStatus.qrDataUrl = null;
    }

    // Un seul QR ASCII : les renouvellements WhatsApp (~20s) polluaient le terminal en boucle.
    if (!isRefresh) {
        console.log('🔑 QR WhatsApp prêt — scannez-le dans le tableau de bord');
        qrcodeTerminal.generate(qr, { small: true });
    } else {
        console.log(`🔄 Token WhatsApp renouvelé (#${whatsappStatus.qrCount}) — image mise à jour sans relancer le navigateur`);
    }
}

function clearQr() {
    whatsappStatus.qr = null;
    whatsappStatus.qrSig = null;
    whatsappStatus.qrDataUrl = null;
}

// Chromium téléchargé par puppeteer : ~/.cache/puppeteer/chrome/<build>/chrome-win64/chrome.exe
// La version la plus récente est retenue (tri décroissant sur le nom du build).
function findPuppeteerCachedBrowsers() {
    const roots = [
        process.env.PUPPETEER_CACHE_DIR,
        path.join(os.homedir(), '.cache', 'puppeteer')
    ].filter(Boolean);

    const binaries = process.platform === 'win32'
        ? [['chrome', 'chrome-win64', 'chrome.exe'], ['chrome-headless-shell', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe']]
        : [['chrome', 'chrome-linux64', 'chrome'], ['chrome-headless-shell', 'chrome-headless-shell-linux64', 'chrome-headless-shell']];

    const found = [];
    for (const root of roots) {
        for (const [product, dirName, exeName] of binaries) {
            const productDir = path.join(root, product);
            if (!fs.existsSync(productDir)) continue;
            const builds = fs.readdirSync(productDir).sort().reverse();
            for (const build of builds) {
                const exe = path.join(productDir, build, dirName, exeName);
                if (fs.existsSync(exe)) found.push(exe);
            }
        }
    }
    return found;
}

async function resolveBrowserPath() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        process.env.EDGE_PATH,
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ...findPuppeteerCachedBrowsers()
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function clearDirSafe(dirPath) {
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log('🧹 Nettoyé:', path.basename(dirPath));
        }
    } catch (error) {
        console.warn('Impossible de nettoyer', dirPath, error.message);
    }
}

async function destroyClient() {
    clientReadyAt = 0;
    if (!client) return;
    try {
        client.removeAllListeners();
        await client.destroy();
    } catch (_) {
        /* ignore */
    }
    client = null;
}

function buildPuppeteerOptions(browserPath) {
    const options = {
        // 'new' est plus stable que true sur Windows avec whatsapp-web.js
        headless: process.env.WA_HEADLESS === 'false' ? false : 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=site-per-process',
            '--disable-background-networking'
        ],
        timeout: 120000
    };

    if (browserPath) {
        options.executablePath = browserPath;
    }
    return options;
}

function attachClientEvents(waClient) {
    let qrDebounce = null;
    let lastQrRaw = null;

    waClient.on('qr', (qr) => {
        if (qr === lastQrRaw) return;
        lastQrRaw = qr;
        if (qrDebounce) clearTimeout(qrDebounce);
        // inject() de whatsapp-web.js se relance à chaque navigation de frame
        // et ré-émet le QR. On ne garde que le dernier token après 400ms.
        qrDebounce = setTimeout(() => {
            setQr(qr).catch((error) => {
                console.error('Erreur setQr:', error.message);
            });
        }, 400);
    });

    waClient.on('ready', () => {
        whatsappStatus.state = 'ready';
        whatsappStatus.lastReadyAt = new Date().toISOString();
        whatsappStatus.lastDisconnectReason = null;
        clientReadyAt = Date.now();
        clearQr();
        console.log('✅ WhatsApp connecté !');
    });

    waClient.on('authenticated', () => {
        if (whatsappStatus.state === 'ready') return;
        whatsappStatus.state = 'connecting';
        marquerPretSiDejaConnecte().catch(() => {});
    });

    waClient.on('loading_screen', (percent, message) => {
        console.log(`⏳ WhatsApp loading: ${percent}% ${message || ''}`);
    });

    waClient.on('disconnected', (reason) => {
        whatsappStatus.state = 'disconnected';
        whatsappStatus.lastDisconnectReason = reason || 'Raison inconnue';
        clearQr();
        console.log('⚠️ WhatsApp déconnecté:', whatsappStatus.lastDisconnectReason);
    });

    waClient.on('auth_failure', (msg) => {
        whatsappStatus.state = 'disconnected';
        whatsappStatus.lastDisconnectReason = msg || 'Échec authentification';
        clearQr();
        console.error('❌ Échec auth WhatsApp:', whatsappStatus.lastDisconnectReason);
    });

    waClient.on('error', (error) => {
        console.error('❌ Client WhatsApp:', error && error.message ? error.message : error);
        if (isTransientBrowserError(error)) {
            markWhatsAppCrashed(error);
        }
    });

    waClient.on('message', (message) => {
        const from = message && message.from ? String(message.from) : 'unknown';
        const prev = chatQueues.get(from) || Promise.resolve();
        const next = prev
            .then(() => handleMessage(message))
            .catch((error) => {
                console.error('Erreur message WhatsApp:', error);
            });
        chatQueues.set(from, next);
    });
}

async function createAndInitializeClient({ clearAuth = false, clearCache = false } = {}) {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    const cachePath = path.join(__dirname, '.wwebjs_cache');

    if (clearCache) clearDirSafe(cachePath);
    if (clearAuth) clearDirSafe(authPath);

    await destroyClient();

    const browserPath = await resolveBrowserPath();
    if (browserPath) {
        console.log('🌐 Navigateur WhatsApp:', browserPath);
    } else {
        console.log('🌐 Navigateur WhatsApp: Chromium intégré (whatsapp-web.js)');
    }

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath, clientId: 'bot-livreurs' }),
        puppeteer: buildPuppeteerOptions(browserPath),
        webVersionCache: {
            type: 'local',
            path: path.join(__dirname, '.wwebjs_cache')
        },
        restartOnAuthFail: false
    });

    attachClientEvents(client);
    await client.initialize();
    return client;
}

function isTransientBrowserError(error) {
    const msg = String(error && error.message ? error.message : error).toLowerCase();
    return (
        msg.includes('frame was detached') ||
        msg.includes('target closed') ||
        msg.includes('session closed') ||
        msg.includes('browser has disconnected') ||
        msg.includes('navigation failed') ||
        msg.includes('execution context was destroyed')
    );
}

function markWhatsAppCrashed(error) {
    whatsappStatus.state = 'disconnected';
    whatsappStatus.lastDisconnectReason = 'Session WhatsApp interrompue. Cliquez sur « Générer le QR ».';
    initializing = false;
    clientReadyAt = 0;
    clearQr();
    client = null;
    console.error('⚠️ WhatsApp a planté, le tableau de bord reste actif:', error && error.message ? error.message : error);
}

process.on('uncaughtException', (error) => {
    if (isTransientBrowserError(error)) {
        markWhatsAppCrashed(error);
        return;
    }
    console.error('uncaughtException:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (isTransientBrowserError(error)) {
        markWhatsAppCrashed(error);
        return;
    }
    console.error('unhandledRejection:', error);
});

async function marquerPretSiDejaConnecte() {
    if (whatsappStatus.state === 'ready' && client) return true;
    if (!client) return false;
    try {
        const state = await client.getState();
        if (state === 'CONNECTED') {
            whatsappStatus.state = 'ready';
            whatsappStatus.lastReadyAt = new Date().toISOString();
            whatsappStatus.lastDisconnectReason = null;
            clientReadyAt = Date.now();
            clearQr();
            console.log('✅ WhatsApp connecté !');
            return true;
        }
    } catch (_) { /* pas encore prêt */ }
    return false;
}

async function attendreQrOuPret(timeoutMs = 20000) {
    const debut = Date.now();
    while (Date.now() - debut < timeoutMs) {
        if (whatsappStatus.state === 'ready' || whatsappStatus.state === 'qr') return;
        if (await marquerPretSiDejaConnecte()) return;
        await new Promise((resolve) => setTimeout(resolve, 400));
    }
}

async function initWhatsApp(force = false) {
    if (!force) {
        if (await marquerPretSiDejaConnecte()) return client;
        if (initializing) return client;
        if (client && (whatsappStatus.state === 'connecting' || whatsappStatus.state === 'qr')) {
            return client;
        }
    }

    if (initializing && !force) return client;

    initializing = true;
    whatsappStatus.state = 'connecting';
    if (force) {
        clearQr();
        whatsappStatus.qrCount = 0;
    }

    try {
        await createAndInitializeClient();
        await attendreQrOuPret();
        return client;
    } catch (error) {
        const raw = error.message || 'Échec initialisation WhatsApp';
        whatsappStatus.state = 'disconnected';
        whatsappStatus.lastDisconnectReason = /could not find chrome|browser was not found/i.test(raw)
            ? 'Chromium introuvable. Lancez : npx puppeteer browsers install chrome'
            : raw;
        await destroyClient();
        throw error;
    } finally {
        initializing = false;
    }
}

async function reconnectWhatsApp(force = false) {
    return initWhatsApp(force);
}

function extraireNumeroLocal(texte) {
    const compact = String(texte || '').trim();
    const hash = compact.match(/#(\d+)/);
    if (hash) return parseInt(hash[1], 10);
    const fin = compact.match(/(\d+)\s*$/);
    return fin ? parseInt(fin[1], 10) : null;
}

function parseCommande(texte) {
    const normalise = texte.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const id = extraireNumeroLocal(texte);

    if (/^accept(e|ee|er)?\b/.test(normalise)) {
        return { action: 'accepter', id };
    }
    if (/^refus(e|ee|er)?\b/.test(normalise)) {
        return { action: 'refuser', id };
    }
    if (/^livr(e|ee|er)\b/.test(normalise)) {
        return { action: 'livrer', id };
    }
    return { action: null, id: null };
}

function parseButtonSelection(message) {
    const selectedId = (message && (message.selectedButtonId || message.selectedRowId || message.body)) || '';
    if (!selectedId) return { action: null, id: null };

    const normalized = String(selectedId).trim();
    if (normalized.startsWith('accept:')) {
        return { action: 'accepter', id: Number(normalized.split(':')[1]) || null };
    }
    if (normalized.startsWith('refuse:')) {
        return { action: 'refuser', id: Number(normalized.split(':')[1]) || null };
    }
    if (normalized.startsWith('livrer:')) {
        return { action: 'livrer', id: Number(normalized.split(':')[1]) || null };
    }

    return { action: null, id: null };
}

function numeroLivreur(commande) {
    const n = Number(commande && commande.numero_local);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

async function resoudreCommandeAssignee(livreurId, numeroLocal) {
    if (numeroLocal) {
        const parLocal = await dbUtils.getCommandeByNumeroLocal(livreurId, numeroLocal, ['ASSIGNEE']);
        if (parLocal) return parLocal;
    }
    const commandes = await dbUtils.getCommandesAssignees(livreurId);
    if (commandes.length === 1) return commandes[0];
    return null;
}

async function resoudreCommandeEnLivraison(livreurId, numeroLocal) {
    if (numeroLocal) {
        const parLocal = await dbUtils.getCommandeByNumeroLocal(livreurId, numeroLocal, ['EN_LIVRAISON']);
        if (parLocal) return parLocal;
    }
    const commandes = await dbUtils.getCommandesEnLivraisonActives(livreurId);
    if (commandes.length === 1) return commandes[0];
    return null;
}

function messageChoixCommandes(commandes, action) {
    const verbe = action === 'accepter' ? 'accepté' : action === 'refuser' ? 'refusé' : 'livré';
    const exemple = numeroLivreur(commandes[0]);
    return `📋 Vous avez ${commandes.length} commandes en cours.\n\n` +
        commandes.map(c => `• ${numeroLivreur(c)} — ${c.client_nom} (${c.statut === 'ASSIGNEE' ? 'à accepter' : 'en livraison'})`).join('\n') +
        `\n\n➡️ Répondez : "${verbe} ${exemple}"`;
}

async function envoyerConfirmationAcceptation(to, commande) {
    const n = numeroLivreur(commande);
    const corps = `✅ Commande ${n} acceptée ! Bonne livraison 🚀

👤 ${commande.client_nom}
📍 ${commande.client_adresse}

───────────────
📋 *Voir plus :*
🍕 ${commande.contenu}
💰 ${commande.montant ? commande.montant + ' €' : 'Non spécifié'}
📱 ${commande.client_telephone || 'Non fourni'}
───────────────

⬇️ Une fois livrée, envoyez :
"livré ${n}"`;

    await client.sendMessage(to, corps);
}

async function gererAcceptation(livreur, from, commandeId) {
    const commande = await resoudreCommandeAssignee(livreur.id, commandeId);
    if (!commande) {
        const enAttente = await dbUtils.getCommandesAssignees(livreur.id);
        if (enAttente.length > 1) {
            await client.sendMessage(from, messageChoixCommandes(enAttente, 'accepter'));
            return;
        }
        await client.sendMessage(from, '❌ Aucune commande en attente de votre réponse.');
        return;
    }

    try {
        await dbUtils.accepterCommande(commande.id, livreur.id);
        await dbUtils.updateLivreurStatut(livreur.numero_whatsapp, 'DISPONIBLE');
        await envoyerConfirmationAcceptation(from, commande);
    } catch (error) {
        await client.sendMessage(from, `❌ Impossible d'accepter la commande ${numeroLivreur(commande)} : ${error.message}`);
    }
}

async function gererRefus(livreur, from, commandeId) {
    const commande = await resoudreCommandeAssignee(livreur.id, commandeId);
    if (!commande) {
        const enAttente = await dbUtils.getCommandesAssignees(livreur.id);
        if (enAttente.length > 1) {
            await client.sendMessage(from, messageChoixCommandes(enAttente, 'refuser'));
            return;
        }
        await client.sendMessage(from, '❌ Aucune commande en attente de votre réponse.');
        return;
    }

    try {
        await dbUtils.refuserCommande(commande.id, livreur.id);
        await dbUtils.updateLivreurStatut(livreur.numero_whatsapp, 'DISPONIBLE');
        await client.sendMessage(from, `❌ Commande ${numeroLivreur(commande)} refusée. Nous cherchons un autre livreur.`);
    } catch (error) {
        await client.sendMessage(from, `❌ Impossible de refuser la commande ${numeroLivreur(commande)} : ${error.message}`);
    }
}

async function gererLivraison(livreur, from, commandeId) {
    const commande = await resoudreCommandeEnLivraison(livreur.id, commandeId);
    if (!commande) {
        const enLivraison = await dbUtils.getCommandesEnLivraisonActives(livreur.id);
        if (enLivraison.length > 1) {
            await client.sendMessage(from, messageChoixCommandes(enLivraison, 'livrer'));
            return;
        }
        await client.sendMessage(from, '❌ Aucune commande en cours de livraison.');
        return;
    }

    try {
        await dbUtils.livrerCommande(commande.id, livreur.id);
        const restantes = await dbUtils.getCommandesByLivreur(livreur.id);
        await dbUtils.updateLivreurStatut(livreur.numero_whatsapp, 'DISPONIBLE');

        if (restantes.length === 0) {
            await client.sendMessage(from, `✅ Commande ${numeroLivreur(commande)} livrée ! Vous êtes à nouveau disponible.`);
        } else {
            await client.sendMessage(from,
                `✅ Commande ${numeroLivreur(commande)} livrée !\n\n` +
                `📦 Il vous reste ${restantes.length} commande(s) en cours.\n` +
                `Tapez "statut" pour voir le détail.`
            );
        }
    } catch (error) {
        await client.sendMessage(from, `❌ Impossible de valider la livraison ${numeroLivreur(commande)} : ${error.message}`);
    }
}

function estMessageDejaVu(message) {
    const id = message && message.id && (message.id._serialized || String(message.id));
    if (!id) return false;
    const now = Date.now();
    if (seenMessageIds.has(id)) return true;
    seenMessageIds.set(id, now);
    if (seenMessageIds.size > 400) {
        for (const [key, seenAt] of seenMessageIds) {
            if (now - seenAt > 10 * 60 * 1000) seenMessageIds.delete(key);
        }
    }
    return false;
}

function estMessageTropAncien(message) {
    if (!clientReadyAt) return true;
    const ts = Number(message.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return true;
    return (ts * 1000) < (clientReadyAt - 3000);
}

function estMessageIgnorable(message) {
    if (!message || message.fromMe) return true;
    if (!clientReadyAt) return true;
    const from = String(message.from || '');
    if (from === 'status@broadcast') return true;
    if (from.endsWith('@g.us') || from.endsWith('@newsletter')) return true;
    const type = String(message.type || 'chat');
    if (!['chat', 'list_response', 'buttons_response'].includes(type)) return true;
    if (estMessageDejaVu(message)) return true;
    if (estMessageTropAncien(message)) return true;
    return false;
}

function estNumeroTelephoneReel(valeur) {
    const d = String(valeur || '').replace(/\D/g, '');
    if (!d) return false;
    if (d.length < 10 || d.length > 13) return false;
    if (/^33[1-9]\d{8}$/.test(d)) return true;
    if (/^0[1-9]\d{8}$/.test(d)) return true;
    if (d.length >= 10 && d.length <= 12 && !d.startsWith('10')) return true;
    return false;
}

function normaliserNumeroWhatsApp(valeur) {
    let d = String(valeur || '').replace(/\D/g, '');
    if (d.startsWith('0033')) d = '33' + d.slice(4);
    if (d.startsWith('0') && d.length === 10) d = '33' + d.slice(1);
    return d;
}

function extraireNumeroDepuisTexte(texte) {
    const compact = String(texte || '').replace(/[\s.\-]/g, '');
    const fr = compact.match(/(?:\+?33|0)[1-9]\d{8}/);
    if (fr) return normaliserNumeroWhatsApp(fr[0]);
    const digits = compact.replace(/\D/g, '');
    return estNumeroTelephoneReel(digits) ? normaliserNumeroWhatsApp(digits) : null;
}

function formaterNumeroAffichage(numero) {
    const d = String(numero || '').replace(/\D/g, '');
    if (d.startsWith('33') && d.length === 11) {
        return ('0' + d.slice(2)).replace(/(\d{2})(?=\d)/g, '$1 ').trim();
    }
    return String(numero || '');
}

function candidatNumero(valeur) {
    if (!valeur) return null;
    if (typeof valeur === 'object') {
        const serialized = String(valeur._serialized || valeur.id || '');
        if (serialized.includes('@lid')) return null;
        const user = valeur.user || (serialized.includes('@') ? serialized.split('@')[0] : '');
        if (serialized.includes('@c.us') || serialized.includes('@s.whatsapp.net')) {
            const n = normaliserNumeroWhatsApp(user);
            return estNumeroTelephoneReel(n) ? n : null;
        }
        const n = normaliserNumeroWhatsApp(user);
        return estNumeroTelephoneReel(n) ? n : null;
    }
    const raw = String(valeur);
    if (raw.includes('@lid')) return null;
    const user = raw.includes('@') ? raw.split('@')[0] : raw;
    const n = extraireNumeroDepuisTexte(user) || (estNumeroTelephoneReel(user) ? normaliserNumeroWhatsApp(user) : null);
    return n;
}

async function resoudreNumeroTelephone(message) {
    const candidats = [];

    if (client && client.pupPage && message.from) {
        try {
            const pageData = await client.pupPage.evaluate(async (id) => {
                const pack = (wid) => {
                    if (!wid) return null;
                    if (typeof wid === 'string') return wid;
                    return {
                        user: wid.user,
                        server: wid.server,
                        _serialized: wid._serialized
                    };
                };
                const out = {};
                try {
                    const pair = await window.WWebJS.enforceLidAndPnRetrieval(id);
                    out.phone = pack(pair && pair.phone);
                    out.lid = pack(pair && pair.lid);
                } catch (_) { /* ignore */ }
                try {
                    const contact = await window.WWebJS.getContact(id);
                    if (contact) {
                        out.userid = contact.userid;
                        out.id = pack(contact.id);
                        out.phoneNumber = pack(contact.phoneNumber);
                    }
                } catch (_) { /* ignore */ }
                try {
                    const wid = window.require('WAWebWidFactory').createWid(id);
                    out.apiPhone = pack(window.require('WAWebApiContact').getPhoneNumber(wid));
                } catch (_) { /* ignore */ }
                return out;
            }, message.from);
            if (pageData) {
                candidats.push(pageData.phone, pageData.phoneNumber, pageData.apiPhone, pageData.userid, pageData.id);
            }
        } catch (_) { /* ignore */ }
    }

    try {
        const contact = await message.getContact();
        if (contact) {
            candidats.push(contact.number);
            candidats.push(contact.id);
            if (typeof contact.getFormattedNumber === 'function') {
                try {
                    candidats.push(await contact.getFormattedNumber());
                } catch (_) { /* ignore */ }
            }
        }
    } catch (_) { /* ignore */ }

    candidats.push(message.from);
    for (const c of candidats) {
        const n = candidatNumero(c);
        if (n) return n;
    }
    return null;
}

async function trouverLivreur(message, senderNumber) {
    const from = message.from;
    let livreur = await dbUtils.getLivreurByWhatsAppId(from);
    if (!livreur && senderNumber) {
        livreur = await dbUtils.getLivreurByNumero(senderNumber);
    }
    const tel = await resoudreNumeroTelephone(message);
    if (!livreur && tel) {
        livreur = await dbUtils.getLivreurByNumero(tel);
    }
    if (livreur && tel && !estNumeroTelephoneReel(livreur.numero_whatsapp)) {
        try {
            await dbUtils.updateLivreurNumero(livreur.id, tel);
            livreur.numero_whatsapp = tel;
            console.log(`📱 Numéro réel enregistré pour ${livreur.prenom}: ${tel}`);
        } catch (error) {
            console.warn('Impossible de mettre à jour le numéro:', error.message);
        }
    }
    return { livreur, tel };
}

async function enregistrerNumeroLivreur(livreur, tel) {
    await dbUtils.updateLivreurNumero(livreur.id, tel);
    livreur.numero_whatsapp = tel;
    console.log(`📱 Numéro réel enregistré pour ${livreur.prenom}: ${tel}`);
}

async function handleMessage(message) {
    if (estMessageIgnorable(message)) return;

    const from = message.from;
    const body = message.body || '';
    const bodyLower = body.toLowerCase().trim();
    const senderNumber = from.split('@')[0];

    const { livreur, tel } = await trouverLivreur(message, senderNumber);

    if (!livreur) {
        if (!bodyLower) return;
        return handleInscription(from, bodyLower, senderNumber, body.trim(), tel);
    }

    if (livreur.whatsapp_id !== from) {
        await dbUtils.updateLivreurWhatsAppIdById(livreur.id, from);
        livreur.whatsapp_id = from;
    }

    if (!estNumeroTelephoneReel(livreur.numero_whatsapp)) {
        const saisi = extraireNumeroDepuisTexte(body);
        if (saisi) {
            try {
                await enregistrerNumeroLivreur(livreur, saisi);
                await client.sendMessage(from,
                    `✅ Merci ${livreur.prenom} ! Votre numéro ${formaterNumeroAffichage(saisi)} a bien été enregistré.`
                );
            } catch (error) {
                await client.sendMessage(from, '❌ Ce numéro est déjà utilisé. Envoyez un autre numéro au format 06 12 34 56 78.');
            }
            return;
        }
    }

    const buttonAction = ['buttons_response', 'list_response'].includes(message.type)
        ? parseButtonSelection(message)
        : { action: null, id: null };
    const { action, id } = buttonAction.action ? buttonAction : parseCommande(bodyLower);

    if (action === 'accepter') {
        await gererAcceptation(livreur, from, id);
        return;
    }
    if (action === 'refuser') {
        await gererRefus(livreur, from, id);
        return;
    }
    if (action === 'livrer') {
        await gererLivraison(livreur, from, id);
        return;
    }

    if (!bodyLower) return;

    switch (bodyLower) {
        case 'disponible':
            await dbUtils.updateLivreurStatut(livreur.numero_whatsapp, 'DISPONIBLE');
            {
                let msgDispo = `✅ Bonjour ${livreur.prenom} ! Vous êtes maintenant disponible pour recevoir des commandes.`;
                if (!estNumeroTelephoneReel(livreur.numero_whatsapp)) {
                    msgDispo += `\n\n📱 Envoyez votre numéro de téléphone (ex: 06 12 34 56 78) pour l'afficher sur le tableau de bord.`;
                }
                await client.sendMessage(from, msgDispo);
            }
            break;

        case 'indisponible':
        case 'pause':
            await dbUtils.updateLivreurStatut(livreur.numero_whatsapp, 'INDISPONIBLE');
            await client.sendMessage(from, `⏸️ Compris ${livreur.prenom}, vous êtes maintenant indisponible.`);
            break;

        case 'statut': {
            const assignees = await dbUtils.getCommandesAssignees(livreur.id);
            const enLivraison = await dbUtils.getCommandesEnLivraisonActives(livreur.id);
            const total = assignees.length + enLivraison.length;
            let messageStatut = `📊 ${livreur.prenom}, voici vos commandes :\n` +
                `📦 Total en cours : ${total}\n`;

            if (assignees.length > 0) {
                messageStatut += `\n📨 En attente de réponse :\n` +
                    assignees.map(c => `  - ${numeroLivreur(c)} : ${c.client_nom}`).join('\n');
            }
            if (enLivraison.length > 0) {
                messageStatut += `\n\n🚚 En livraison :\n` +
                    enLivraison.map(c => `  - ${numeroLivreur(c)} : ${c.client_nom}`).join('\n');
            }
            if (total === 0) {
                messageStatut += `\n✅ Aucune commande en cours.`;
            }
            await client.sendMessage(from, messageStatut);
            break;
        }

        default:
            if (!estNumeroTelephoneReel(livreur.numero_whatsapp)) {
                await client.sendMessage(from,
                    `📱 ${livreur.prenom}, envoyez votre numéro de téléphone (ex: 06 12 34 56 78) pour l'afficher sur le tableau de bord.`
                );
                return;
            }
            await client.sendMessage(from,
                `🤖 Commandes disponibles :\n` +
                `• "disponible" - Être prêt à livrer\n` +
                `• "indisponible" - Faire une pause\n` +
                `• "statut" - Voir vos commandes\n` +
                `• "accepté 1" - Accepter la commande 1\n` +
                `• "refusé 1" - Refuser la commande 1\n` +
                `• "livré 1" - Valider une livraison`
            );
    }
}

async function finaliserInscription(from, numero, prenom) {
    try {
        await dbUtils.createLivreur(numero, prenom, '', from);
    } catch (error) {
        await client.sendMessage(from, '❌ Inscription impossible. Ce numéro est peut-être déjà inscrit. Réessayez avec "bonjour".');
        sessions.delete(from);
        return;
    }
    sessions.delete(from);
    await client.sendMessage(from,
        `✅ Inscription terminée !\n\n` +
        `🎉 Bienvenue ${prenom} !\n` +
        `📱 Numéro enregistré : ${formaterNumeroAffichage(numero)}\n\n` +
        `Vous pouvez maintenant utiliser :\n` +
        `• "disponible" - Pour commencer à recevoir des commandes\n` +
        `• "indisponible" - Pour faire une pause\n` +
        `• "statut" - Voir vos commandes`
    );
}

async function handleInscription(from, bodyLower, senderNumber, bodyOriginal, telResolu) {
    let session = sessions.get(from) || { step: 0 };

    if (bodyLower === 'bonjour' || bodyLower === 'hello' || bodyLower === 'salut') {
        sessions.set(from, { step: 1, telephone: telResolu || null });
        await client.sendMessage(from, '👋 Bienvenue ! Pour vous inscrire, quel est votre prénom ?');
        return;
    }

    const saisi = (bodyOriginal || bodyLower).trim();
    const telSession = session.telephone || telResolu || null;

    switch (session.step) {
        case 1: {
            if (!saisi) {
                await client.sendMessage(from, 'Quel est votre prénom ?');
                return;
            }
            const tel = telSession && estNumeroTelephoneReel(telSession) ? telSession : null;
            if (!tel) {
                sessions.set(from, { step: 2, prenom: saisi, telephone: null });
                await client.sendMessage(from,
                    `✅ Merci ${saisi}. Quel est votre numéro de téléphone ?\nEx: 06 12 34 56 78`
                );
                return;
            }
            await finaliserInscription(from, tel, saisi);
            break;
        }

        case 2:
        case 3: {
            const tel = extraireNumeroDepuisTexte(bodyOriginal);
            if (!tel) {
                await client.sendMessage(from, '❌ Numéro invalide. Envoyez un numéro français, ex: 06 12 34 56 78');
                return;
            }
            await finaliserInscription(from, tel, session.prenom);
            break;
        }

        default:
            break;
    }
}

function formatMessageTexte(commande) {
    const n = numeroLivreur(commande);
    return `📦 NOUVELLE COMMANDE À LIVRER

🆔 Commande ${n}
👤 Client : ${commande.client_nom}
📍 Adresse : ${commande.client_adresse}
📱 Tél : ${commande.client_telephone || 'Non fourni'}

🍕 Contenu :
${commande.contenu}

💰 Montant : ${commande.montant || 'Non spécifié'}€

➡️ RÉPONDEZ :
• "accepté ${n}"
• "refusé ${n}"`;
}

async function sendMessage(to, message) {
    if (!client) {
        return Promise.reject(new Error('WhatsApp non initialisé'));
    }
    return client.sendMessage(to, message);
}

async function sendCommandeAuLivreur(whatsappId, commande) {
    if (!client) throw new Error('WhatsApp non initialisé');
    await client.sendMessage(whatsappId, formatMessageTexte(commande));
}

module.exports = {
    initWhatsApp,
    reconnectWhatsApp,
    sendMessage,
    sendCommandeAuLivreur,
    getWhatsAppStatus
};
