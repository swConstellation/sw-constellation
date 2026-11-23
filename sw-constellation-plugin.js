// Modules natifs explicites, chargés par le require CommonJS de SWEX / Electron.
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Plugin SW Constellation API pour sw-exporter (production / open-source).
 *
 * Intercepte les commandes SWEX utiles et les envoie à l'API Constellation.
 * Allowlist locale (fallback) + rafraîchissement via GET /api/commands/supported.
 */

const CONSTELLATION_API_URL = 'https://api.swc.gg';
/** En-tête HTTP fixe (pas une option plugin). La valeur est l'InboundApiKey membre. */
const INBOUND_API_KEY_HEADER = 'X-Constellation-Guild-Key';

/** Seules ces clés apparaissent dans les settings SWEX. */
const ALLOWED_PLUGIN_CONFIG_KEYS = new Set(['enabled', 'inboundApiKey', 'showLogs']);

/**
 * Fallback joueur : pas de firehose siège / keep-alive.
 * Aligné sur SwexInboundCommands.PlayerSupported.
 */
const DEFAULT_PLAYER_COMMANDS = [
    'GetWizardInfo',
    'GetWizardData',
    'setGuildSiegeMarkDefenseDeck',
    'SetGuildSiegeDefenseDeck',
    'ModifyGuildSiegeDefenseDeck'
];

/**
 * Catalogue complet (écoute). Les commandes siège ne partent que si session = ObservateurWizardId.
 * Aligné sur SwexInboundCommands.Supported.
 */
const DEFAULT_FULL_COMMANDS = [
    'GetGuildSiegeMatchupInfo',
    'GetGuildSiegeBattleLog',
    'getGuildSiegeMatchBattleLogSummary_v2',
    'GetGuildSiegeMemberStatSeasonList',
    'GetGuildSiegeBaseDefenseUnitList',
    'GetGuildSiegeAttackUnitListInBattle',
    'GetGuildSiegeAttackUnitInfoInBattle',
    'GetGuildSiegeBattleReplayData',
    'GetGuildSiegeParticipationInfo',
    'GetWizardInfo',
    'GetWizardData',
    'UpdateAlive',
    'UpdateAlive_V2',
    'setGuildSiegeMarkDefenseDeck',
    'SetGuildSiegeDefenseDeck',
    'ModifyGuildSiegeDefenseDeck'
];


/** Jamais écrire dans plugins/ : SWEX require() chaque entrée du dossier (un .log casse tout). */
function resolveLogFilePath() {
    let dir = __dirname;
    if (path.basename(dir) === 'plugins') {
        return path.join(path.dirname(dir), 'sw-constellation-plugin.log');
    }
    if (path.basename(path.dirname(dir)) === 'plugins') {
        return path.join(path.dirname(path.dirname(dir)), 'sw-constellation-plugin.log');
    }
    return path.join(dir, 'sw-constellation-plugin.log');
}

const logFilePath = resolveLogFilePath();
function writeLog(level, message) {
    let text = typeof message === 'string' ? message : JSON.stringify(message);
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    fs.appendFile(logFilePath, line, { encoding: 'utf8' }, () => { });
}

const logger = {
    info: (msg) => writeLog('INFO', msg),
    warn: (msg) => writeLog('WARN', msg),
    error: (msg) => writeLog('ERROR', msg)
};

const DUPLICATE_TTL_MS = 500;
const _recentCommands = new Map();
/** Catalogue complet reconnu (joueur + siège). @type {Set<string>} */
let _supportedCommands = new Set(DEFAULT_FULL_COMMANDS.map((c) => c.toLowerCase()));
/** Sous-ensemble joueur (toujours envoyé). @type {Set<string>} */
let _playerCommands = new Set(DEFAULT_PLAYER_COMMANDS.map((c) => c.toLowerCase()));
/** ObservateurWizardId guilde (API). @type {number|null} */
let _observateurWizardId = null;
/** wizard_id du compte jeu SWEX connecté (HubUserLogin / request). @type {number|null} */
let _sessionWizardId = null;

function toCommandSet(commands) {
    const next = new Set();
    if (!Array.isArray(commands)) return next;
    for (const name of commands) {
        if (typeof name === 'string' && name.trim()) {
            next.add(name.trim().toLowerCase());
        }
    }
    return next;
}

function isDuplicateCommand(key) {
    const now = Date.now();
    for (const [k, ts] of _recentCommands) {
        if (now - ts > DUPLICATE_TTL_MS) _recentCommands.delete(k);
    }
    if (_recentCommands.has(key)) return true;
    _recentCommands.set(key, now);
    return false;
}

function isKnownCommand(commandName) {
    if (!commandName || typeof commandName !== 'string') return false;
    return _supportedCommands.has(commandName.trim().toLowerCase());
}

function isPlayerCommand(commandName) {
    if (!commandName || typeof commandName !== 'string') return false;
    return _playerCommands.has(commandName.trim().toLowerCase());
}

function extractWizardId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const direct = obj.wizard_id ?? obj.wizardId;
    if (direct != null && Number.isFinite(Number(direct)) && Number(direct) > 0) {
        return Number(direct);
    }
    if (obj.request && typeof obj.request === 'object') {
        const nested = extractWizardId(obj.request);
        if (nested) return nested;
    }
    if (obj.wizard_info && typeof obj.wizard_info === 'object') {
        const fromInfo = obj.wizard_info.wizard_id ?? obj.wizard_info.wizardId;
        if (fromInfo != null && Number.isFinite(Number(fromInfo)) && Number(fromInfo) > 0) {
            return Number(fromInfo);
        }
    }
    return null;
}

function noteSessionWizardId(wizardId) {
    if (!wizardId || !Number.isFinite(Number(wizardId)) || Number(wizardId) <= 0) return;
    const next = Number(wizardId);
    if (_sessionWizardId === next) return;
    _sessionWizardId = next;
}

function isObservateurSession(requestData) {
    if (!_observateurWizardId) return false;
    const fromReq = extractWizardId(requestData);
    const session = fromReq || _sessionWizardId;
    return !!session && Number(session) === Number(_observateurWizardId);
}

/**
 * Joueur : always forward player commands.
 * Siège / keep-alive : only if connected game account == ObservateurWizardId.
 */
function shouldForwardCommand(commandName, requestData) {
    if (!isKnownCommand(commandName)) return false;
    if (isPlayerCommand(commandName)) return true;
    return isObservateurSession(requestData);
}

function applyCatalog(fullCommands, playerCommands) {
    const full = toCommandSet(fullCommands);
    const player = toCommandSet(playerCommands);
    if (full.size === 0) return;
    _supportedCommands = full;
    if (player.size > 0) {
        _playerCommands = player;
    }
}

function isTruthyConfigFlag(value) {
    return value === true || value === 1 || value === 'true' || value === '1';
}

function sanitizePluginConfig(config) {
    const name = module.exports.pluginName;
    const cfg = config?.Config?.Plugins?.[name];
    if (!cfg || typeof cfg !== 'object') return;

    // Lodash merge SWEX conserve d'anciennes clés (apiUrl, observateurMode, …) → UI polluée.
    for (const key of Object.keys(cfg)) {
        if (!ALLOWED_PLUGIN_CONFIG_KEYS.has(key)) {
            delete cfg[key];
        }
    }

    // SWEX affiche une checkbox seulement si la valeur stockée est un boolean
    // (`type: 'boolean'` dans defaultConfigDetails est interprété comme input HTML).
    cfg.showLogs = isTruthyConfigFlag(cfg.showLogs);
}

function tryEmitProxyLog(proxy, type, message) {
    if (typeof proxy?.log !== 'function') return;
    try {
        proxy.log({ type, source: 'plugin', name: module.exports.pluginName, message: String(message) });
    } catch {
        // ignore
    }
}

function makePluginLogger(proxy, showLogs) {
    const emit = (level, type, msg) => {
        if (!showLogs) return;
        logger[level](msg);
        tryEmitProxyLog(proxy, type, msg);
    };
    return {
        info: (msg) => emit('info', 'info', msg),
        warn: (msg) => emit('warn', 'warn', msg),
        error: (msg) => emit('error', 'error', msg)
    };
}

function httpGetJson(urlObj, extraHeaders) {
    return new Promise((resolve, reject) => {
        const httpModuleLocal = urlObj.protocol === 'https:' ? https : http;
        const headers = { Accept: 'application/json', ...extraHeaders };
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: (urlObj.pathname || '') + (urlObj.search || ''),
            method: 'GET',
            headers,
            timeout: 8000
        };

        const req = httpModuleLocal.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

function refreshSupportedCommands() {
    let supportedUrl;
    try {
        supportedUrl = new URL('/api/commands/supported', new URL(CONSTELLATION_API_URL));
    } catch {
        return;
    }

    httpGetJson(supportedUrl)
        .then((payload) => {
            applyCatalog(
                payload?.commands || DEFAULT_FULL_COMMANDS,
                payload?.playerCommands || DEFAULT_PLAYER_COMMANDS
            );
        })
        .catch(() => { });
}

function refreshObservateurWizardId(inboundApiKey) {
    const key = inboundApiKey ? String(inboundApiKey).trim() : '';
    if (!key) return;

    let url;
    try {
        url = new URL('/api/inbound/member/observateur', new URL(CONSTELLATION_API_URL));
    } catch {
        return;
    }

    httpGetJson(url, { [INBOUND_API_KEY_HEADER]: key })
        .then((payload) => {
            const id = payload?.observateurWizardId ?? payload?.ObservateurWizardId;
            if (id != null && Number.isFinite(Number(id)) && Number(id) > 0) {
                _observateurWizardId = Number(id);
            } else {
                _observateurWizardId = null;
            }
        })
        .catch(() => { });
}

module.exports = {
    defaultConfig: {
        enabled: true,
        inboundApiKey: '',
        showLogs: false
    },
    defaultConfigDetails: {
        inboundApiKey: {
            label: 'InboundApiKey',
            type: 'string',
            description:
                'Clé inbound membre (site joueur). Auth guilde. Le mode observateur est automatique : si le compte jeu SWEX connecté = ObservateurWizardId de la guilde, le firehose siège part ; sinon allowlist joueur seulement.'
        },
        showLogs: {
            label: 'Show logs',
            description: 'Affiche le log de succès des commandes envoyées.'
        }
    },
    pluginName: 'SW Constellation API',
    pluginDescription: 'Envoie certaines commandes SWEX à Constellation',

    init: function (proxy, config) {
        sanitizePluginConfig(config);

        const pluginConfig = config?.Config?.Plugins?.['SW Constellation API'];

        if (!pluginConfig?.enabled) {
            return;
        }

        const inboundApiKey = typeof pluginConfig.inboundApiKey === 'string'
            ? pluginConfig.inboundApiKey.trim()
            : '';
        const showLogs = isTruthyConfigFlag(pluginConfig.showLogs);
        const pLogger = makePluginLogger(proxy, showLogs);

        applyCatalog(DEFAULT_FULL_COMMANDS, DEFAULT_PLAYER_COMMANDS);
        refreshSupportedCommands();
        refreshObservateurWizardId(inboundApiKey);

        const onProfileLogin = (...args) => {
            try {
                const req = args.length >= 2 ? args[0] : null;
                const resp = args.length >= 2 ? args[1] : args[0];
                let profile = resp;
                if (!resp?.building_list && req?.building_list) profile = req;
                noteSessionWizardId(extractWizardId(profile) || extractWizardId(resp) || extractWizardId(req));
                handleProfileExport(profile, pLogger, inboundApiKey);
            } catch (err) {
                pLogger.warn(`[SW Constellation API] Import profil exception: ${err?.message || err}`);
            }
        };
        proxy.on('HubUserLogin', onProfileLogin);
        proxy.on('GuestLogin', onProfileLogin);

        const onKeepAlive = (commandName) => (req, resp) => {
            try {
                noteSessionWizardId(extractWizardId(resp) || extractWizardId(req));
                handleCommand(commandName, req, resp, pLogger, inboundApiKey);
            } catch {
                // ignore
            }
        };
        proxy.on('UpdateAlive', onKeepAlive('UpdateAlive'));
        proxy.on('UpdateAlive_V2', onKeepAlive('UpdateAlive_V2'));

        proxy.on('apiCommand', (...args) => {
            try {
                let commandName;
                let req = null;
                let resp = null;

                if (args.length === 1) {
                    req = args[0];
                    commandName = req?.command || req?.commandName || req?.type || req?.name;
                } else if (args.length >= 2) {
                    if (typeof args[0] === 'string') {
                        commandName = args[0];
                        req = args[1] || null;
                        resp = args[2] || null;
                    } else {
                        req = args[0] || null;
                        resp = args[1] || null;
                        commandName = req?.command || req?.commandName || req?.type || req?.name;
                    }
                }

                if (commandName) {
                    handleCommand(commandName, req, resp, pLogger, inboundApiKey);
                }
            } catch {
                // ignore
            }
        });
    }
};

function handleCommand(commandName, requestData, responseData, pLogger, inboundApiKey) {
    const fromReq = extractWizardId(requestData) || extractWizardId(responseData);
    if (fromReq) {
        noteSessionWizardId(fromReq);
    }

    if (!shouldForwardCommand(commandName, requestData)) {
        return;
    }

    const dedupeKey = `${commandName}:${JSON.stringify(requestData || {})}`;
    if (isDuplicateCommand(dedupeKey)) {
        return;
    }

    const MAX_REDIRECTS = 5;
    const payload = {
        command: commandName,
        request: requestData,
        response: responseData,
        timestamp: new Date().toISOString()
    };
    const jsonPayload = JSON.stringify(payload);

    let endpointUrl;
    try {
        const baseUrl = new URL(CONSTELLATION_API_URL);
        endpointUrl = new URL(`/api/commands/${commandName}`, baseUrl);
    } catch {
        return;
    }

    function doRequest(urlObj, redirectsRemaining) {
        const httpModuleLocal = urlObj.protocol === 'https:' ? https : http;
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonPayload)
        };
        const key = inboundApiKey ? String(inboundApiKey).trim() : '';
        if (key) {
            headers[INBOUND_API_KEY_HEADER] = key;
        }

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: (urlObj.pathname || '') + (urlObj.search || ''),
            method: 'POST',
            headers,
            timeout: 15000
        };

        const req = httpModuleLocal.request(options, (res) => {
            res.on('data', () => { });
            res.on('end', () => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers?.location) {
                    if (redirectsRemaining > 0) {
                        try {
                            const nextUrl = new URL(res.headers?.location, urlObj);
                            return doRequest(nextUrl, redirectsRemaining - 1);
                        } catch {
                            return;
                        }
                    }
                    return;
                }

                if (res.statusCode >= 200 && res.statusCode < 300 && res.statusCode !== 204) {
                    pLogger.info(`[SW Constellation API] Commande "${commandName}" envoyée avec succès (${res.statusCode})`);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });

        req.on('error', () => { });

        req.write(jsonPayload);
        req.end();
    }

    doRequest(endpointUrl, MAX_REDIRECTS);
}

/**
 * Même payload que ProfileExport écrit sur disque (HubUserLogin / GuestLogin).
 * POST /api/inbound/member/import-json — pipeline identique à l'import site joueur.
 */
function handleProfileExport(resp, pLogger, inboundApiKey) {
    const log = pLogger || { info() {}, warn() {} };
    if (!resp || typeof resp !== 'object') {
        log.warn('[SW Constellation API] Import profil ignoré : payload login vide');
        return;
    }
    if (!resp.building_list) {
        log.warn('[SW Constellation API] Import profil ignoré : JSON incomplet (building_list manquant)');
        return;
    }

    const wizardId = resp?.wizard_info?.wizard_id;
    if (!wizardId) {
        log.warn('[SW Constellation API] Import profil ignoré : wizard_id manquant');
        return;
    }

    const key = inboundApiKey ? String(inboundApiKey).trim() : '';
    if (!key) {
        log.warn('[SW Constellation API] Import profil ignoré : InboundApiKey absente');
        return;
    }

    const dedupeKey = `profile-import:${wizardId}:${resp?.wizard_info?.wizard_last_login || resp?.tvalue || ''}`;
    if (isDuplicateCommand(dedupeKey)) {
        return;
    }

    const wizardIdText = String(wizardId);
    const fileName = /^[0-9]{1,19}$/.test(wizardIdText)
        ? `swex-profile-${wizardIdText}.json`
        : 'swex-profile.json';
    const jsonPayload = JSON.stringify(resp);

    let endpointUrl;
    try {
        endpointUrl = new URL('/api/inbound/member/import-json', new URL(CONSTELLATION_API_URL));
    } catch (error) {
        log.warn(`[SW Constellation API] Import profil ignoré : URL invalide (${error?.message || error})`);
        return;
    }

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonPayload),
        [INBOUND_API_KEY_HEADER]: key,
        'X-Constellation-Profile-FileName': fileName
    };

    const options = {
        hostname: endpointUrl.hostname,
        port: endpointUrl.port || (endpointUrl.protocol === 'https:' ? 443 : 80),
        path: (endpointUrl.pathname || '') + (endpointUrl.search || ''),
        method: 'POST',
        headers,
        timeout: 60000
    };

    const httpModuleLocal = endpointUrl.protocol === 'https:' ? https : http;
    const req = httpModuleLocal.request(options, (res) => {
        res.on('data', () => { });
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                log.info(`[SW Constellation API] Import profil envoyé avec succès (${res.statusCode})`);
            } else {
                log.warn(`[SW Constellation API] Import profil échec (${res.statusCode})`);
            }
        });
    });
    req.on('timeout', () => {
        req.destroy(new Error('timeout'));
        log.warn('[SW Constellation API] Import profil échec : timeout');
    });
    req.on('error', () => {
        log.warn('[SW Constellation API] Import profil échec réseau');
    });
    req.write(jsonPayload);
    req.end();
}
