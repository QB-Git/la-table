const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const ENV_FILE = path.join(ROOT, '.env');
try {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Impossible de lire .env : ${error.message}`);
}
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Le port doit être un nombre entier compris entre 1 et 65535.');
}
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL = 14 * 24 * 60 * 60 * 1000;
const STAT_NAMES = ['Physique', 'Dextérité', 'Agilité', 'Intelligence', 'Volonté', 'Perception'];

fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return { users: [], groups: [], characters: [] };
}

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      characters: Array.isArray(parsed.characters) ? parsed.characters.map((character) => {
        const stats = normalizeStoredStats(character.stats);
        const statPointsInitial = Number.isInteger(character.statPointsInitial)
          ? Math.max(24, Math.min(114, character.statPointsInitial))
          : statTotal(stats);
        const statPointsBonus = Number.isInteger(character.statPointsBonus)
          ? Math.max(0, Math.min(114 - statPointsInitial, character.statPointsBonus))
          : 0;
        return {
          ...character,
          stats,
          inventory: Array.isArray(character.inventory) ? cleanLines(character.inventory, 50) : [],
          statPointsInitial,
          statPointsBonus
        };
      }) : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Impossible de lire ${DATA_FILE}:`, error.message);
      process.exit(1);
    }
    return emptyDb();
  }
}

let db = loadDb();
const sessions = new Map();
const streams = new Set();
const loginAttempts = new Map();

function saveDb() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, DATA_FILE);
}

function id() {
  return crypto.randomUUID();
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

function groupFor(groupId) {
  return db.groups.find((group) => group.id === groupId);
}

function memberRole(groupId, userId) {
  const group = groupFor(groupId);
  if (!group) return null;
  if (group.ownerId === userId) return 'mj';
  return group.memberIds.includes(userId) ? 'player' : null;
}

function publicCharacter(character) {
  if (!character) return null;
  const stats = normalizeStoredStats(character.stats);
  return {
    id: character.id,
    groupId: character.groupId,
    userId: character.userId,
    name: character.name,
    firstName: character.firstName,
    job: character.job,
    stats,
    statPointsAvailable: remainingStatPoints(character, stats),
    luck: character.luck,
    skills: character.skills,
    flaws: character.flaws,
    inventory: character.inventory || [],
    updatedAt: character.updatedAt
  };
}

function mjCharacter(character) {
  if (!character) return null;
  return {
    ...publicCharacter(character),
    statPointsInitial: character.statPointsInitial,
    statPointsBonus: character.statPointsBonus || 0,
    privateStats: character.privateStats || []
  };
}

function groupSummary(group, user) {
  return {
    id: group.id,
    name: group.name,
    role: memberRole(group.id, user.id),
    playerCount: group.memberIds.length
  };
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function currentUser(req) {
  const token = cookieValue(req, 'table_session');
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = db.users.find((item) => item.id === session.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return user;
}

function cookieOptions(req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`;
}

function createSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `table_session=${token}; ${cookieOptions(req)}`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('JSON invalide.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLength = 80) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanLines(value, maxItems = 20) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  return list.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, maxItems);
}

function normalizeStoredStats(value) {
  const result = {};
  for (const name of STAT_NAMES) {
    const number = Number(value?.[name]);
    result[name] = Number.isFinite(number) ? Math.max(4, Math.min(19, Math.round(number))) : 10;
  }
  return result;
}

function cleanStats(value, min, max, fallback = 10) {
  const result = {};
  for (const name of STAT_NAMES) {
    if (value?.[name] === undefined || value?.[name] === null || value?.[name] === '') {
      result[name] = typeof fallback === 'object' ? fallback[name] ?? 10 : fallback;
      continue;
    }
    const number = Number(value[name]);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw Object.assign(new Error(`La caractéristique « ${name} » doit être comprise entre ${min} et ${max}.`), { status: 400 });
    }
    result[name] = number;
  }
  return result;
}

function statTotal(stats) {
  return STAT_NAMES.reduce((total, name) => total + Number(stats?.[name] || 0), 0);
}

function remainingStatPoints(character, stats = normalizeStoredStats(character.stats)) {
  return Math.max(0, Number(character.statPointsInitial || 0) + Number(character.statPointsBonus || 0) - statTotal(stats));
}

function cleanPrivateStats(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((stat) => ({
    name: cleanText(stat?.name, 50),
    value: Math.max(0, Math.min(999, Number.isFinite(Number(stat?.value)) ? Math.round(Number(stat.value)) : 0))
  })).filter((stat) => stat.name);
}

function defaultCharacter(groupId, userId, fields = {}) {
  return {
    id: id(), groupId, userId,
    name: cleanText(fields.name, 50),
    firstName: cleanText(fields.firstName, 50),
    job: cleanText(fields.job, 80),
    stats: cleanStats(fields.stats || {}, 4, 19, 4),
    statPointsInitial: Number(fields.statPointsInitial),
    statPointsBonus: 0,
    luck: 0,
    skills: ['Atout à définir 1', 'Atout à définir 2'],
    flaws: ['Défaut à définir'],
    inventory: [],
    privateStats: [
      { name: 'Points de vie', value: 10 },
      { name: 'Santé mentale', value: 10 },
      { name: 'Fatigue', value: 1 },
      { name: 'Douleur', value: 0 }
    ],
    updatedAt: new Date().toISOString()
  };
}

function canManage(user, groupId) {
  return memberRole(groupId, user.id) === 'mj';
}

function broadcast(groupId, event) {
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) {
    if (stream.groupId === groupId && memberRole(groupId, stream.userId)) {
      try { stream.res.write(message); } catch { streams.delete(stream); }
    }
  }
}

function closeUserStreams(userId) {
  for (const stream of streams) {
    if (stream.userId === userId) {
      streams.delete(stream);
      stream.res.end();
    }
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const attempted = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(attempted, hash);
}

function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 12) return true;
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  return false;
}

function validOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch { return false; }
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: 'Connecte-toi pour continuer.' });
  return user;
}

async function api(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  let body;

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !validOrigin(req)) {
    return json(res, 403, { error: 'Origine de la requête refusée.' });
  }

  if (route === '/api/status' && method === 'GET') {
    return json(res, 200, { needsSetup: db.users.length === 0 });
  }

  if (route === '/api/setup' && method === 'POST') {
    if (db.users.length !== 0) return json(res, 409, { error: 'Le compte MJ existe déjà.' });
    body = await parseBody(req);
    const username = cleanText(body.username, 40);
    const password = typeof body.password === 'string' ? body.password : '';
    if (username.length < 3 || password.length < 6) {
      return json(res, 400, { error: 'Choisis un identifiant (3 caractères minimum) et un mot de passe (6 minimum).' });
    }
    const user = { id: id(), username, role: 'mj', passwordHash: hashPassword(password) };
    db.users.push(user);
    saveDb();
    createSession(res, req, user);
    return json(res, 201, { user: publicUser(user) });
  }

  if (route === '/api/login' && method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
    body = await parseBody(req);
    const username = cleanText(body.username, 40).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.users.find((item) => item.username.toLowerCase() === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return json(res, 401, { error: 'Identifiant ou mot de passe incorrect.' });
    }
    loginAttempts.delete(req.socket.remoteAddress || 'unknown');
    createSession(res, req, user);
    return json(res, 200, { user: publicUser(user) });
  }

  if (route === '/api/logout' && method === 'POST') {
    const token = cookieValue(req, 'table_session');
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'table_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (route === '/api/me' && method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;
    const groups = db.groups.filter((group) => group.ownerId === user.id || group.memberIds.includes(user.id))
      .map((group) => groupSummary(group, user));
    return json(res, 200, { user: publicUser(user), groups });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (route === '/api/password' && method === 'POST') {
    body = await parseBody(req);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!verifyPassword(currentPassword, user.passwordHash)) return json(res, 400, { error: 'Le mot de passe actuel est incorrect.' });
    if (newPassword.length < 6) return json(res, 400, { error: 'Le nouveau mot de passe doit faire au moins 6 caractères.' });
    user.passwordHash = hashPassword(newPassword);
    const currentToken = cookieValue(req, 'table_session');
    for (const [token, session] of sessions) {
      if (session.userId === user.id && token !== currentToken) sessions.delete(token);
    }
    closeUserStreams(user.id);
    saveDb();
    return json(res, 200, { ok: true });
  }

  const resetPasswordMatch = route.match(/^\/api\/groups\/([\w-]+)\/players\/([\w-]+)\/password$/);
  if (resetPasswordMatch && method === 'POST') {
    const [, groupId, playerId] = resetPasswordMatch;
    const group = groupFor(groupId);
    if (!group || !canManage(user, groupId) || !group.memberIds.includes(playerId)) {
      return json(res, 404, { error: 'Joueur introuvable dans ce groupe.' });
    }
    const player = db.users.find((item) => item.id === playerId && item.role === 'player');
    if (!player) return json(res, 404, { error: 'Compte joueur introuvable.' });
    body = await parseBody(req);
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 6) return json(res, 400, { error: 'Le nouveau mot de passe doit faire au moins 6 caractères.' });
    player.passwordHash = hashPassword(newPassword);
    for (const [token, session] of sessions) {
      if (session.userId === player.id) sessions.delete(token);
    }
    closeUserStreams(player.id);
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (route === '/api/groups' && method === 'POST') {
    if (user.role !== 'mj') return json(res, 403, { error: 'Seul le MJ peut créer un dossier.' });
    body = await parseBody(req);
    const name = cleanText(body.name, 70);
    if (!name) return json(res, 400, { error: 'Donne un nom au groupe.' });
    const group = { id: id(), name, ownerId: user.id, memberIds: [], createdAt: new Date().toISOString() };
    db.groups.push(group);
    saveDb();
    return json(res, 201, { group: groupSummary(group, user) });
  }

  const groupMatch = route.match(/^\/api\/groups\/([\w-]+)$/);
  if (groupMatch && method === 'PATCH') {
    const group = groupFor(groupMatch[1]);
    if (!group || !canManage(user, group.id)) return json(res, 404, { error: 'Groupe introuvable.' });
    body = await parseBody(req);
    const name = cleanText(body.name, 70);
    if (!name) return json(res, 400, { error: 'Le nom du groupe ne peut pas être vide.' });
    group.name = name;
    saveDb();
    broadcast(group.id, { type: 'refresh' });
    return json(res, 200, { group: groupSummary(group, user) });
  }

  if (groupMatch && method === 'GET') {
    const group = groupFor(groupMatch[1]);
    const role = group && memberRole(group.id, user.id);
    if (!group || !role) return json(res, 404, { error: 'Groupe introuvable.' });
    const visibleMemberIds = role === 'mj' ? group.memberIds : group.memberIds.filter((memberId) => memberId === user.id);
    const members = visibleMemberIds.map((memberId) => {
      const member = db.users.find((item) => item.id === memberId);
      const character = db.characters.find((item) => item.groupId === group.id && item.userId === memberId);
      return member ? {
        user: publicUser(member),
        character: role === 'mj'
          ? mjCharacter(character)
          : publicCharacter(character)
      } : null;
    }).filter(Boolean);
    return json(res, 200, { group: groupSummary(group, user), members });
  }

  const playersMatch = route.match(/^\/api\/groups\/([\w-]+)\/players$/);
  if (playersMatch && method === 'POST') {
    const group = groupFor(playersMatch[1]);
    if (!group || !canManage(user, group.id)) return json(res, 404, { error: 'Groupe introuvable.' });
    body = await parseBody(req);
    const username = cleanText(body.username, 40);
    const password = typeof body.password === 'string' ? body.password : '';
    const statPointsInitial = Number(body.statPointsInitial);
    if (username.length < 3) return json(res, 400, { error: 'Identifiant trop court (3 caractères minimum).' });
    if (!Number.isInteger(statPointsInitial) || statPointsInitial < 24 || statPointsInitial > 114) {
      return json(res, 400, { error: 'Le budget initial doit être compris entre 24 et 114 points.' });
    }
    let player = db.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    let created = false;
    if (!player) {
      if (password.length < 6) return json(res, 400, { error: 'Pour un nouveau compte, le mot de passe doit faire au moins 6 caractères.' });
      player = { id: id(), username, role: 'player', passwordHash: hashPassword(password) };
      db.users.push(player);
      created = true;
    } else if (player.role !== 'player') {
      return json(res, 409, { error: 'Cet identifiant est déjà celui du MJ.' });
    }
    if (group.memberIds.includes(player.id)) return json(res, 409, { error: 'Ce joueur est déjà dans ce dossier.' });
    group.memberIds.push(player.id);
    const character = defaultCharacter(group.id, player.id, { ...(body.character || {}), statPointsInitial });
    db.characters.push(character);
    saveDb();
    broadcast(group.id, { type: 'refresh' });
    return json(res, 201, { member: { user: publicUser(player), character: publicCharacter(character) }, created });
  }

  const characterMatch = route.match(/^\/api\/characters\/([\w-]+)$/);
  if (characterMatch && method === 'PATCH') {
    body = await parseBody(req);
    const character = db.characters.find((item) => item.id === characterMatch[1]);
    if (!character || !memberRole(character.groupId, user.id)) return json(res, 404, { error: 'Fiche introuvable.' });
    const isMj = canManage(user, character.groupId);
    if (!isMj && character.userId !== user.id) return json(res, 403, { error: 'Tu ne peux modifier que ta propre fiche.' });
    const currentStats = normalizeStoredStats(character.stats);
    const nextStats = body.stats !== undefined ? cleanStats(body.stats, 4, 19, currentStats) : currentStats;
    let nextBonus = Number(character.statPointsBonus || 0);
    if (isMj && body.statPointsBonus !== undefined) {
      nextBonus = Number(body.statPointsBonus);
      const maxBonus = 114 - Number(character.statPointsInitial);
      if (!Number.isInteger(nextBonus) || nextBonus < 0 || nextBonus > maxBonus) {
        return json(res, 400, { error: `Les points bonus doivent être compris entre 0 et ${maxBonus}.` });
      }
    }
    if (statTotal(nextStats) > Number(character.statPointsInitial) + nextBonus) {
      return json(res, 400, { error: 'La somme des caractéristiques dépasse les points disponibles. Accorde des points bonus ou baisse une caractéristique.' });
    }
    if (body.name !== undefined) character.name = cleanText(body.name, 50);
    if (body.firstName !== undefined) character.firstName = cleanText(body.firstName, 50);
    if (body.job !== undefined) character.job = cleanText(body.job, 80);
    if (body.stats !== undefined) character.stats = nextStats;
    if (isMj) character.statPointsBonus = nextBonus;
    if (body.luck !== undefined) character.luck = Math.max(0, Math.min(99, Number.isFinite(Number(body.luck)) ? Math.round(Number(body.luck)) : 0));
    if (body.skills !== undefined) character.skills = cleanLines(body.skills, 20);
    if (body.flaws !== undefined) character.flaws = cleanLines(body.flaws, 20);
    if (body.inventory !== undefined) character.inventory = cleanLines(body.inventory, 50);
    if (isMj && body.privateStats !== undefined) character.privateStats = cleanPrivateStats(body.privateStats);
    character.updatedAt = new Date().toISOString();
    saveDb();
    broadcast(character.groupId, { type: 'refresh' });
    return json(res, 200, { character: isMj ? mjCharacter(character) : publicCharacter(character) });
  }

  const eventsMatch = route.match(/^\/api\/groups\/([\w-]+)\/events$/);
  if (eventsMatch && method === 'GET') {
    const groupId = eventsMatch[1];
    if (!memberRole(groupId, user.id)) return json(res, 404, { error: 'Groupe introuvable.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2500\n\n');
    const stream = { groupId, userId: user.id, res };
    streams.add(stream);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); streams.delete(stream); }
    }, 20000);
    req.on('close', () => { clearInterval(keepAlive); streams.delete(stream); });
    return;
  }

  return json(res, 404, { error: 'Route introuvable.' });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const handler = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Méthode non autorisée.' });
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
      return json(res, 403, { error: 'Accès refusé.' });
    }
    fs.readFile(file, (error, content) => {
      if (error) return json(res, 404, { error: 'Fichier introuvable.' });
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(content);
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Une erreur inattendue est survenue.' });
    else res.end();
  }
};

let server;
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  const tls = require('node:https');
  server = tls.createServer({
    key: fs.readFileSync(path.resolve(process.env.TLS_KEY)),
    cert: fs.readFileSync(path.resolve(process.env.TLS_CERT))
  }, handler);
} else {
  server = http.createServer(handler);
}

server.listen(PORT, HOST, () => {
  const protocol = process.env.TLS_KEY && process.env.TLS_CERT ? 'https' : 'http';
  console.log(`Table de jeu disponible sur ${protocol}://localhost:${PORT}`);
  console.log(`Données enregistrées dans : ${DATA_FILE}`);
  if (db.users.length === 0) console.log('Ouvre la page pour créer le compte du MJ.');
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
