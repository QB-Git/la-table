const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Le serveur s’est arrêté avant de démarrer.');
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Le serveur n’a pas démarré à temps.');
}

async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-table-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  async function call(endpoint, { method = 'GET', cookie, body } = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  try {
    const status = await waitForServer(baseUrl, child);
    assert.equal(status.needsSetup, true);

    const tooShortSetup = await call('/api/setup', { method: 'POST', body: { username: 'maitre', password: 'abcde' } });
    assert.equal(tooShortSetup.response.status, 400);
    const setup = await call('/api/setup', { method: 'POST', body: { username: 'maitre', password: 'secret' } });
    assert.equal(setup.response.status, 201);
    const mjCookie = setup.cookie;

    const group = await call('/api/groups', { method: 'POST', cookie: mjCookie, body: { name: 'Groupe test' } });
    assert.equal(group.response.status, 201);
    const groupId = group.data.group.id;

    const invalidBudget = await call(`/api/groups/${groupId}/players`, {
      method: 'POST', cookie: mjCookie,
      body: { username: 'joueur', password: 'joueur', statPointsInitial: 23 }
    });
    assert.equal(invalidBudget.response.status, 400);
    const added = await call(`/api/groups/${groupId}/players`, {
      method: 'POST', cookie: mjCookie,
      body: { username: 'joueur', password: 'joueur', statPointsInitial: 60 }
    });
    assert.equal(added.response.status, 201);
    const characterId = added.data.member.character.id;
    assert.equal(added.data.member.character.skills.length, 2);
    assert.equal(added.data.member.character.flaws.length, 1);
    assert.equal(added.data.member.character.inventory.length, 0);
    assert.equal(added.data.member.character.notes, '');
    assert.equal(added.data.member.character.name, '');
    assert.equal(added.data.member.character.firstName, '');
    assert.deepEqual(Object.keys(added.data.member.character.stats), ['Physique', 'Dextérité', 'Agilité', 'Intelligence', 'Volonté', 'Perception']);
    assert.ok(Object.values(added.data.member.character.stats).every((value) => value === 4));
    assert.equal(added.data.member.character.statPointsAvailable, 36);

    const group2 = await call('/api/groups', { method: 'POST', cookie: mjCookie, body: { name: 'Second groupe' } });
    const reusedPlayer = await call(`/api/groups/${group2.data.group.id}/players`, {
      method: 'POST', cookie: mjCookie, body: { username: 'Joueur', statPointsInitial: 60 }
    });
    assert.equal(reusedPlayer.response.status, 201);
    assert.equal(reusedPlayer.data.created, false);

    const mjView = await call(`/api/groups/${groupId}`, { cookie: mjCookie });
    assert.equal(mjView.data.members[0].character.privateStats.length, 4);
    assert.equal(mjView.data.members[0].character.privateStats[0].name, 'Points de vie');
    assert.equal(mjView.data.members[0].character.stats.Vitesse, undefined);
    assert.equal(mjView.data.members[0].character.statPointsInitial, 60);
    assert.equal(mjView.data.members[0].character.statPointsBonus, 0);
    assert.equal((await call('/api/overview', { cookie: mjCookie })).response.status, 404);

    const login = await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'joueur' } });
    assert.equal(login.response.status, 200);
    const playerCookie = login.cookie;
    const playerView = await call(`/api/groups/${groupId}`, { cookie: playerCookie });
    assert.equal(playerView.data.members.length, 1);
    assert.equal(playerView.data.members[0].character.privateStats, undefined);
    assert.equal(playerView.data.members[0].character.statPointsInitial, undefined);
    assert.equal(playerView.data.members[0].character.statPointsBonus, undefined);
    assert.equal(playerView.data.members[0].character.statPointsAvailable, 36);
    assert.equal((await call('/api/overview', { cookie: playerCookie })).response.status, 404);

    const lowStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: playerCookie, body: { stats: { Physique: 3 } } });
    assert.equal(lowStat.response.status, 400);
    const highStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: playerCookie, body: { stats: { Physique: 20 } } });
    assert.equal(highStat.response.status, 400);
    const highPlayerStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: playerCookie, body: { stats: { Physique: 19 } } });
    assert.equal(highPlayerStat.response.status, 200);
    assert.equal(highPlayerStat.data.character.stats.Physique, 19);
    assert.equal(highPlayerStat.data.character.statPointsAvailable, 21);
    const overBudget = await call(`/api/characters/${characterId}`, {
      method: 'PATCH', cookie: playerCookie,
      body: { stats: { Physique: 19, Dextérité: 19, Agilité: 19, Intelligence: 19, Volonté: 19, Perception: 19 } }
    });
    assert.equal(overBudget.response.status, 400);
    const mjLowStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: mjCookie, body: { stats: { Physique: 3 } } });
    assert.equal(mjLowStat.response.status, 400);
    const mjHighStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: mjCookie, body: { stats: { Physique: 20 } } });
    assert.equal(mjHighStat.response.status, 400);
    const bonusGrant = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: mjCookie, body: { statPointsBonus: 15 } });
    assert.equal(bonusGrant.response.status, 200);
    assert.equal(bonusGrant.data.character.statPointsBonus, 15);
    assert.equal(bonusGrant.data.character.statPointsAvailable, 36);
    const playerBudgetView = await call(`/api/groups/${groupId}`, { cookie: playerCookie });
    assert.equal(playerBudgetView.data.members[0].character.statPointsAvailable, 36);
    assert.equal(playerBudgetView.data.members[0].character.statPointsBonus, undefined);

    const loreUpdate = await call(`/api/characters/${characterId}`, {
      method: 'PATCH', cookie: playerCookie, body: { notes: 'A grandi à Valombre.\nCherche son frère.' }
    });
    assert.equal(loreUpdate.response.status, 200);
    assert.equal(loreUpdate.data.character.notes, 'A grandi à Valombre.\nCherche son frère.');
    const remoteInventoryUpdate = await call(`/api/characters/${characterId}`, {
      method: 'PATCH', cookie: mjCookie, body: { inventory: ['Objet ajouté par le MJ'] }
    });
    assert.equal(remoteInventoryUpdate.response.status, 200);
    const loreAfterRemoteUpdate = await call(`/api/characters/${characterId}`, {
      method: 'PATCH', cookie: playerCookie, body: { notes: 'Lore ajusté après la modification du MJ.' }
    });
    assert.equal(loreAfterRemoteUpdate.response.status, 200);
    assert.deepEqual(loreAfterRemoteUpdate.data.character.inventory, ['Objet ajouté par le MJ']);
    assert.equal(loreAfterRemoteUpdate.data.character.notes, 'Lore ajusté après la modification du MJ.');

    const validStat = await call(`/api/characters/${characterId}`, { method: 'PATCH', cookie: playerCookie, body: { statPointsBonus: 999 } });
    assert.equal(validStat.response.status, 200);
    assert.equal(validStat.data.character.statPointsBonus, undefined);

    const forbidden = await call(`/api/characters/${characterId}`, {
      method: 'PATCH', cookie: playerCookie, body: { privateStats: [{ name: 'Secret', value: 999 }] }
    });
    assert.equal(forbidden.response.status, 200);
    assert.equal(forbidden.data.character.privateStats, undefined);
    const stillPrivate = await call(`/api/groups/${groupId}`, { cookie: mjCookie });
    assert.equal(stillPrivate.data.members[0].character.privateStats.length, 4);
    assert.deepEqual(stillPrivate.data.members[0].character.inventory, ['Objet ajouté par le MJ']);
    assert.equal(stillPrivate.data.members[0].character.notes, 'Lore ajusté après la modification du MJ.');

    const wrongCurrentPassword = await call('/api/password', {
      method: 'POST', cookie: playerCookie, body: { currentPassword: 'wrongpw', newPassword: 'joueur-nouveau' }
    });
    assert.equal(wrongCurrentPassword.response.status, 400);
    const changeOwnPassword = await call('/api/password', {
      method: 'POST', cookie: playerCookie, body: { currentPassword: 'joueur', newPassword: 'joueur-nouveau' }
    });
    assert.equal(changeOwnPassword.response.status, 200);
    assert.equal((await call('/api/groups/' + groupId, { cookie: playerCookie })).response.status, 200);
    assert.equal((await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'joueur' } })).response.status, 401);
    const newLogin = await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'joueur-nouveau' } });
    assert.equal(newLogin.response.status, 200);

    const forbiddenReset = await call(`/api/groups/${groupId}/players/${added.data.member.user.id}/password`, {
      method: 'POST', cookie: newLogin.cookie, body: { newPassword: 'reset-joueur' }
    });
    assert.equal(forbiddenReset.response.status, 404);
    const resetPassword = await call(`/api/groups/${groupId}/players/${added.data.member.user.id}/password`, {
      method: 'POST', cookie: mjCookie, body: { newPassword: 'reset-joueur' }
    });
    assert.equal(resetPassword.response.status, 200);
    assert.equal((await call(`/api/groups/${groupId}`, { cookie: newLogin.cookie })).response.status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'joueur-nouveau' } })).response.status, 401);
    const resetLogin = await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'reset-joueur' } });
    assert.equal(resetLogin.response.status, 200);

    const removeFromGroup = await call(`/api/groups/${group2.data.group.id}/players/${added.data.member.user.id}`, {
      method: 'DELETE', cookie: mjCookie
    });
    assert.equal(removeFromGroup.response.status, 200);
    assert.equal((await call(`/api/groups/${group2.data.group.id}`, { cookie: mjCookie })).data.members.length, 0);
    assert.equal((await call(`/api/groups/${groupId}`, { cookie: mjCookie })).data.members.length, 1);
    assert.equal((await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'reset-joueur' } })).response.status, 200);

    const forbiddenAccountDelete = await call(`/api/users/${added.data.member.user.id}`, { method: 'DELETE', cookie: resetLogin.cookie });
    assert.equal(forbiddenAccountDelete.response.status, 403);
    const deleteAccount = await call(`/api/users/${added.data.member.user.id}`, { method: 'DELETE', cookie: mjCookie });
    assert.equal(deleteAccount.response.status, 200);
    assert.equal((await call(`/api/groups/${groupId}`, { cookie: mjCookie })).data.members.length, 0);
    assert.equal((await call('/api/login', { method: 'POST', body: { username: 'joueur', password: 'reset-joueur' } })).response.status, 401);

    const deniedGroup = await call(`/api/groups/${groupId}`, { cookie: undefined });
    assert.equal(deniedGroup.response.status, 401);
    console.log('Tests OK : fiches, inventaires, budgets, confidentialité, mots de passe et suppressions MJ.');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
