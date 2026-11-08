const STAT_NAMES = ['Physique', 'Dextérité', 'Agilité', 'Intelligence', 'Volonté', 'Perception'];
const STAT_SHORT = { Physique: 'PHY', Dextérité: 'DEX', Agilité: 'AGI', Intelligence: 'INT', Volonté: 'VOL', Perception: 'PER' };
const state = { user: null, groups: [], group: null, members: [], playerCharacters: [], selectedCharacterId: null, events: null, page: 'welcome', characterDirty: false, characterChanges: new Set() };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function authCard({ title, description, setup = false }) {
  return `<div class="auth-card">
    <div class="auth-brand"><span class="brand-mark">L<span>·</span></span><span class="brand-copy"><strong>LA TABLE</strong><small>un espace de jeu</small></span></div>
    <div class="eyebrow"><span class="eyebrow-line"></span> ${setup ? 'PREMIÈRE UTILISATION' : 'ESPACE PRIVÉ'}</div>
    <h1>${title}</h1><p>${description}</p>
    <form id="auth-form">
      <label class="field-label" for="auth-username">Identifiant</label><input class="text-input" id="auth-username" name="username" autocomplete="username" required minlength="3" maxlength="40" placeholder="ex. maitredujeu">
      <label class="field-label" for="auth-password">Mot de passe</label><input class="text-input" id="auth-password" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 6 : 1}" placeholder="${setup ? '6 caractères minimum' : 'Ton mot de passe'}">
      <div class="auth-error" id="auth-error"></div><button class="button button-primary" type="submit">${setup ? 'Créer le compte MJ' : 'Se connecter'} <span>↗</span></button>
    </form>
    ${setup ? '<div class="auth-hint">Ce sera le compte administrateur de toutes tes parties. Le mot de passe est haché et salé avant enregistrement.</div>' : ''}
  </div>`;
}

async function showAuth() {
  $('#app-view').classList.add('hidden');
  const status = await request('/api/status');
  $('#auth-view').classList.remove('hidden');
  $('#auth-view').innerHTML = status.needsSetup
    ? authCard({ title: 'Bienvenue à la table.', description: 'Crée le compte du MJ pour préparer tes dossiers de jeu.', setup: true })
    : authCard({ title: 'La partie continue.', description: 'Connecte-toi pour retrouver tes dossiers et ta fiche.' });
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const error = $('#auth-error');
    error.textContent = '';
    try {
      const endpoint = status.needsSetup ? '/api/setup' : '/api/login';
      await request(endpoint, { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      await enterApp();
    } catch (failure) { error.textContent = failure.message; }
  });
}

async function enterApp(preferredGroupId = state.group?.id) {
  const data = await request('/api/me');
  state.user = data.user;
  state.groups = data.groups;
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  applySidebarState();
  $('#account-name').textContent = state.user.username;
  $('#account-role').textContent = state.user.role === 'mj' ? 'Maître du jeu' : 'Joueur';
  $('#account-avatar').textContent = state.user.username.slice(0, 2);
  renderGroups();
  await refreshPlayerSwitcher();
  if (state.groups.length) {
    const selected = state.groups.find((group) => group.id === preferredGroupId) || state.groups[0];
    await loadGroup(selected.id);
  }
  else showWelcome();
}

function renderGroups() {
  const isMj = state.user.role === 'mj';
  $('#new-group').classList.toggle('hidden', !isMj);
  $('#sidebar-group-heading').classList.toggle('hidden', !isMj);
  $('#group-list').classList.toggle('hidden', !isMj);
  const list = $('#group-list');
  list.innerHTML = state.groups.length ? state.groups.map((group) => `<button class="group-item ${state.group?.id === group.id ? 'active' : ''}" data-group="${group.id}"><span class="folder-icon">▱</span><span class="group-item-name">${escapeHtml(group.name)}</span><span class="group-item-count">${group.playerCount}</span></button>`).join('') : '<div class="sidebar-empty">Aucun dossier</div>';
  $$('.group-item', list).forEach((button) => {
    button.title = button.querySelector('.group-item-name')?.textContent || '';
    button.addEventListener('click', () => { closeMobileSidebar(); loadGroup(button.dataset.group); });
  });
}

function applySidebarState() {
  const collapsed = localStorage.getItem('table-sidebar-collapsed') === 'true';
  $('#app-view').classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle');
  button.textContent = collapsed ? '›' : '‹';
  button.title = collapsed ? 'Déplier le menu' : 'Replier le menu';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
}

function closeMobileSidebar() {
  $('#app-view').classList.remove('sidebar-open');
  $('#sidebar-scrim').classList.add('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}

function confirmUnsavedChanges() {
  return !state.characterDirty || window.confirm('Cette fiche contient des modifications non enregistrées. Les abandonner ?');
}

async function refreshPlayerSwitcher() {
  const select = $('#player-character-switcher');
  if (state.user?.role !== 'player' || state.groups.length < 2) {
    state.playerCharacters = [];
    select.classList.add('hidden');
    select.replaceChildren();
    return;
  }
  const characters = await Promise.all(state.groups.map(async (group) => {
    try {
      const data = await request(`/api/groups/${group.id}`);
      const character = data.members.find((member) => member.user.id === state.user.id)?.character;
      return character ? { groupId: group.id, groupName: group.name, character } : null;
    } catch { return null; }
  }));
  state.playerCharacters = characters.filter(Boolean);
  select.replaceChildren(...state.playerCharacters.map(({ groupId, groupName, character }) => {
    const option = document.createElement('option');
    option.value = groupId;
    const name = [character.firstName, character.name].filter(Boolean).join(' ') || 'Personnage à définir';
    option.textContent = `${name} · ${groupName}`;
    return option;
  }));
  select.classList.toggle('hidden', state.playerCharacters.length < 2);
  if (state.group) select.value = state.group.id;
}

function showWelcome() {
  disconnectEvents();
  state.page = 'welcome';
  state.group = null;
  $('#current-group-name').textContent = 'Choisis un dossier';
  $('#rename-group').classList.add('hidden');
  $('#group-view').classList.add('hidden');
  $('#group-overview').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
  renderGroups();
}

async function loadGroup(groupId) {
  if (state.group && state.group.id !== groupId && !confirmUnsavedChanges()) {
    if (state.user?.role === 'player') $('#player-character-switcher').value = state.group.id;
    return;
  }
  try {
    const data = await request(`/api/groups/${groupId}`);
    closeMobileSidebar();
    state.page = data.group.role === 'mj' ? 'group-overview' : 'group-sheet';
    state.group = data.group;
    state.members = data.members;
    if (!state.members.some((item) => item.character?.id === state.selectedCharacterId)) {
      state.selectedCharacterId = state.user.role === 'mj' ? state.members[0]?.character?.id || null : state.members.find((item) => item.user.id === state.user.id)?.character?.id || null;
    }
    $('#welcome').classList.add('hidden');
    $('#group-view').classList.remove('hidden');
    $('#current-group-name').textContent = state.group.name;
    $('#group-title').textContent = state.group.name;
    $('#group-subtitle').textContent = `${state.members.length} ${state.members.length === 1 ? 'joueur' : 'joueurs'} dans ce dossier`;
    if (state.user.role === 'player') await refreshPlayerSwitcher();
    $('#rename-group').classList.toggle('hidden', state.group.role !== 'mj');
    $('#add-player').classList.toggle('hidden', state.group.role !== 'mj');
    renderGroupContent();
    subscribeEvents(groupId);
    renderGroups();
  } catch (error) { showToast(error.message); }
}

function disconnectEvents() {
  if (state.events) state.events.close();
  state.events = null;
}

function subscribeEvents(groupId) {
  disconnectEvents();
  const events = new EventSource(`/api/groups/${groupId}/events`);
  state.events = events;
  let checkingSession = false;
  events.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'refresh') refreshGroup(groupId);
  };
  events.onerror = async () => {
    if (checkingSession || state.events !== events) return;
    checkingSession = true;
    try { await request('/api/me'); }
    catch (error) {
      if (error.message.includes('Connecte-toi')) {
        disconnectEvents();
        state.user = null; state.groups = []; state.group = null; state.members = [];
        showAuth().catch((failure) => showToast(failure.message));
      }
    } finally { checkingSession = false; }
  };
}

async function refreshGroup(groupId) {
  if (state.group?.id !== groupId) return;
  const selected = state.selectedCharacterId;
  const draft = state.page === 'group-sheet' ? captureCharacterDraft() : null;
  try {
    const [groupData, me] = await Promise.all([request(`/api/groups/${groupId}`), request('/api/me')]);
    state.groups = me.groups;
    state.group = groupData.group;
    state.members = groupData.members;
    const selectedStillExists = state.members.some((item) => item.character?.id === selected);
    state.selectedCharacterId = selectedStillExists
      ? selected
      : state.user.role === 'mj' ? state.members[0]?.character?.id || null : state.members.find((item) => item.user.id === state.user.id)?.character?.id || null;
    $('#group-subtitle').textContent = `${state.members.length} ${state.members.length === 1 ? 'joueur' : 'joueurs'} dans ce dossier`;
    if (state.user.role === 'player') await refreshPlayerSwitcher();
    renderGroupContent();
    if (draft && selectedStillExists) restoreCharacterDraft(draft);
    else if (draft && !selectedStillExists) showToast('La fiche a été retirée pendant tes modifications.');
    renderGroups();
  } catch (error) { showToast(error.message); }
}

function markCharacterField(field) {
  state.characterChanges.add(field);
  state.characterDirty = true;
  const status = $('#save-status');
  if (status) status.textContent = 'Modifications non enregistrées';
}

function captureCharacterDraft() {
  if (!state.characterDirty) return null;
  const form = $('#character-form');
  if (!form) return null;
  const fields = {};
  for (const field of state.characterChanges) {
    if (field.startsWith('stat:')) {
      const stat = field.slice(5);
      const input = $$('[data-stat]', form).find((item) => item.dataset.stat === stat);
      if (input) fields[field] = input.value;
    } else if (field === 'privateStats') {
      fields[field] = $$('.private-row', form).map((row) => ({
        name: $('.private-name-input', row).value,
        value: $('.private-input', row).value
      }));
    } else {
      const control = form.elements.namedItem(field);
      if (control) fields[field] = control.value;
    }
  }
  return { characterId: state.selectedCharacterId, fields };
}

function restoreCharacterDraft(draft) {
  if (draft.characterId !== state.selectedCharacterId) return;
  const form = $('#character-form');
  if (!form) return;
  for (const [field, value] of Object.entries(draft.fields)) {
    if (field.startsWith('stat:')) {
      const stat = field.slice(5);
      const input = $$('[data-stat]', form).find((item) => item.dataset.stat === stat);
      if (input) input.value = value;
    } else if (field === 'privateStats') {
      const list = $('#private-stats', form);
      if (list) list.innerHTML = value.map((stat, index) => privateStatHtml({ name: stat.name, value: Number(stat.value) }, index)).join('');
    } else {
      const control = form.elements.namedItem(field);
      if (control) control.value = value;
    }
  }
  state.characterChanges = new Set(Object.keys(draft.fields));
  state.characterDirty = state.characterChanges.size > 0;
  updateAllocationControls(form, selectedMember().character);
  const status = $('#save-status', form);
  if (status && state.characterDirty) status.textContent = 'Fiche modifiée ailleurs ; tes modifications restent à enregistrer.';
}

function renderGroupContent() {
  const hasMembers = state.members.length > 0;
  const playerSheetOnly = state.group.role === 'player';
  $('#empty-group').classList.toggle('hidden', !(state.group.role === 'mj' && !hasMembers));
  $('#group-overview').classList.toggle('hidden', !hasMembers || state.page !== 'group-overview');
  $('#roster-layout').classList.toggle('hidden', !hasMembers || state.page !== 'group-sheet');
  $('#roster-layout').classList.toggle('player-sheet-only', playerSheetOnly);
  $('#back-to-group-overview').classList.toggle('hidden', state.group.role !== 'mj' || state.page !== 'group-sheet');
  if (!hasMembers) return;
  if (state.page === 'group-sheet') renderRoster();
  else renderGroupOverview();
}

function renderGroupOverview() {
  const view = $('#group-overview');
  const mj = state.group.role === 'mj';
  view.innerHTML = `<div class="group-overview-heading"><span>JOUEURS DE CE GROUPE</span><span class="count-pill">${state.members.length}</span></div><div class="group-overview-grid">${state.members.map((member) => {
    const c = member.character || {};
    const name = [c.firstName, c.name].filter(Boolean).join(' ') || 'Personnage à définir';
    const initials = (c.firstName || c.name || member.user.username).slice(0, 2);
    const stats = STAT_NAMES.map((stat) => `<span class="overview-stat" title="${escapeHtml(stat)}">${STAT_SHORT[stat]} <b>${Number(c.stats?.[stat] ?? 4)}</b></span>`).join('');
    const itemList = (items, empty) => (items || []).length
      ? items.map((item) => `<span class="overview-item-chip">${escapeHtml(item)}</span>`).join('')
      : `<span class="overview-item-empty">${empty}</span>`;
    const secrets = mj && c.privateStats?.length
      ? `<div class="group-overview-secrets">${c.privateStats.map((stat) => `<span>${escapeHtml(stat.name)} <b>${Number(stat.value)}</b></span>`).join('')}</div>`
      : '';
    return `<article class="group-player-card"><button class="group-player-open" data-character="${c.id || ''}"><span class="overview-avatar">${escapeHtml(initials)}</span><span class="group-player-main"><span class="group-player-title"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(member.user.username)}</small></span><span class="group-player-job">${escapeHtml(c.job || 'Identité à compléter')}</span><span class="overview-stats">${stats}</span><span class="group-player-luck">Chance <b>${Number(c.luck || 0)}</b></span><span class="group-player-lists"><span><b>ATOUTS</b>${itemList(c.skills, 'Aucun atout')}</span><span><b>DÉFAUTS</b>${itemList(c.flaws, 'Aucun défaut')}</span></span>${secrets}</span><span class="overview-open" aria-hidden="true">↗</span></button></article>`;
  }).join('')}</div>`;
  $$('.group-player-open', view).forEach((button) => button.addEventListener('click', () => showGroupCharacter(button.dataset.character)));
}

function showGroupOverview() {
  if (!state.group) return;
  if (!confirmUnsavedChanges()) return;
  state.characterDirty = false;
  state.characterChanges.clear();
  state.page = 'group-overview';
  renderGroupContent();
}

function showGroupCharacter(characterId) {
  if (state.selectedCharacterId !== characterId && !confirmUnsavedChanges()) return;
  state.characterDirty = false;
  state.characterChanges.clear();
  state.selectedCharacterId = characterId;
  state.page = 'group-sheet';
  renderGroupContent();
}

function initials(member) {
  const character = member.character;
  return (character?.firstName || character?.name || member.user.username).slice(0, 2);
}

function renderRoster() {
  const roster = $('#roster-list');
  $('#roster-count').textContent = state.members.length;
  roster.innerHTML = state.members.map((member) => {
    const c = member.character;
    const name = c ? [c.firstName, c.name].filter(Boolean).join(' ') || 'Personnage sans nom' : member.user.username;
    return `<button class="roster-item ${state.selectedCharacterId === c?.id ? 'active' : ''}" data-character="${c?.id || ''}"><span class="roster-avatar">${escapeHtml(initials(member))}</span><span class="roster-names"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(c?.job || member.user.username)}</small></span></button>`;
  }).join('');
  $$('.roster-item', roster).forEach((button) => button.addEventListener('click', () => {
    if (state.selectedCharacterId !== button.dataset.character && !confirmUnsavedChanges()) return;
    state.characterDirty = false;
    state.characterChanges.clear();
    state.selectedCharacterId = button.dataset.character;
    renderRoster();
  }));
  renderCharacter();
}

function selectedMember() { return state.members.find((member) => member.character?.id === state.selectedCharacterId); }

function statTotal(stats) {
  return STAT_NAMES.reduce((total, name) => total + Number(stats?.[name] || 0), 0);
}

function updateAllocationControls(form, character) {
  const inputs = $$('.stat-input[data-stat]', form);
  const values = Object.fromEntries(inputs.map((input) => [input.dataset.stat, Number(input.value || 4)]));
  const used = statTotal(values);
  const isMj = state.group.role === 'mj';
  const bonusInput = $('#stat-points-bonus', form);
  const budget = isMj
    ? Number(character.statPointsInitial || 0) + Number(bonusInput?.value || 0)
    : statTotal(character.stats) + Number(character.statPointsAvailable || 0);
  const remaining = budget - used;
  const remainingField = $('#stat-points-available', form);
  remainingField.textContent = String(remaining);
  remainingField.classList.toggle('over-budget', remaining < 0);
  remainingField.closest('.allocation-strip').classList.toggle('hidden', remaining === 0);
  for (const input of inputs) {
    const otherUsed = used - Number(input.value || 4);
    input.max = String(Math.max(4, Math.min(19, budget - otherUsed)));
  }
  if (bonusInput) bonusInput.min = String(Math.max(0, used - Number(character.statPointsInitial || 0)));
}

function renderCharacter() {
  const panel = $('#character-panel');
  const member = selectedMember();
  if (!member) {
    state.characterDirty = false;
    state.characterChanges = new Set();
    panel.innerHTML = '';
    return;
  }
  state.characterDirty = false;
  state.characterChanges = new Set();
  const c = member.character;
  const editable = state.group.role === 'mj' || member.user.id === state.user.id;
  const mj = state.group.role === 'mj';
  const displayName = [c.firstName, c.name].filter(Boolean).join(' ') || 'Personnage sans nom';
  const pointsAvailable = Number(c.statPointsAvailable || 0);
  const statsHtml = STAT_NAMES.map((name, index) => `<div class="stat-card"><label for="stat-${index}">${name}</label><input id="stat-${index}" class="stat-input public-field" type="number" min="4" max="19" step="1" value="${Number(c.stats?.[name] ?? 4)}" data-stat="${escapeHtml(name)}" ${editable ? '' : 'disabled'}></div>`).join('');
  const mjBudgetHtml = mj ? `<div class="mj-allocation-controls"><div class="initial-budget"><small>BUDGET INITIAL</small><strong>${Number(c.statPointsInitial)} <span>pts</span></strong></div><div class="mini-field"><label for="stat-points-bonus">Points bonus accordés</label><input class="text-input compact public-field" id="stat-points-bonus" name="statPointsBonus" type="number" min="0" max="${Math.max(0, 114 - Number(c.statPointsInitial))}" step="1" value="${Number(c.statPointsBonus || 0)}"></div></div>` : '';
  const privateHtml = mj ? `<section class="private-box"><div class="section-title"><span>◈ &nbsp; INDICATEURS MJ</span><span class="private-lock">PRIVÉ</span></div><div id="private-stats" class="private-stats">${(c.privateStats || []).map((stat, i) => privateStatHtml(stat, i)).join('')}</div><div class="private-actions"><button id="add-private-stat" type="button" class="add-stat">＋ Ajouter un indicateur</button><span class="save-status" id="private-status"></span></div></section>` : '';
  panel.innerHTML = `<article class="character-card">
    <header class="character-banner"><div><div class="character-kicker">FICHE PERSONNAGE</div><h2 class="character-name">${escapeHtml(displayName)}</h2><div class="character-job">${escapeHtml(c.job || 'Métier à définir')} <span class="character-job-separator">·</span> joueur <strong>${escapeHtml(member.user.username)}</strong></div></div><span class="owner-tag">${mj ? 'VUE MJ' : 'TA FICHE'}</span></header>
    <form id="character-form" class="character-content">
      <div class="section-title"><span>IDENTITÉ</span><small>Informations de personnage</small></div>
      <div class="identity-grid">
        <div class="mini-field"><label for="char-first-name">Prénom</label><input class="text-input compact public-field" id="char-first-name" name="firstName" maxlength="50" value="${escapeHtml(c.firstName)}" ${editable ? '' : 'disabled'}></div>
        <div class="mini-field"><label for="char-name">Nom</label><input class="text-input compact public-field" id="char-name" name="name" maxlength="50" value="${escapeHtml(c.name)}" ${editable ? '' : 'disabled'}></div>
        <div class="mini-field"><label for="char-job">Métier</label><input class="text-input compact public-field" id="char-job" name="job" maxlength="80" value="${escapeHtml(c.job)}" ${editable ? '' : 'disabled'}></div>
        <div class="mini-field"><label for="char-luck">Points de chance</label><input class="text-input compact public-field" id="char-luck" name="luck" type="number" min="0" max="99" value="${Number(c.luck || 0)}" ${editable ? '' : 'disabled'}></div>
      </div>
      <div class="section-title"><span class="characteristic-heading">CARACTÉRISTIQUES <span class="tooltip-wrap"><button class="tooltip-trigger" type="button" aria-label="Expliquer le calcul d’une caractéristique">i</button><span class="tooltip-content" role="tooltip">Pour une action, lance un d20 et soustrais la caractéristique. Plus sa valeur est basse, mieux c’est.</span></span></span><small>4 à 19</small></div>
      <div class="allocation-strip ${pointsAvailable === 0 ? 'hidden' : ''}"><span>POINTS À DISTRIBUER<small>répartis dans les caractéristiques</small></span><strong id="stat-points-available">${pointsAvailable}</strong></div>
      ${mjBudgetHtml}
      <div class="stats-grid">${statsHtml}</div>
      <div class="list-grid">
        <div class="list-box"><div class="section-title"><span>ATOUTS & COMPÉTENCES</span><small>une ligne par atout</small></div><textarea class="line-textarea public-field" name="skills" aria-label="Atouts et compétences" placeholder="Bon bricoleur · +5 en bricolage" ${editable ? '' : 'disabled'}>${escapeHtml((c.skills || []).join('\n'))}</textarea></div>
        <div class="list-box"><div class="section-title"><span>DÉFAUTS & TRAUMAS</span><small>une ligne par défaut</small></div><textarea class="line-textarea public-field" name="flaws" aria-label="Défauts et traumas" placeholder="Peur du noir…" ${editable ? '' : 'disabled'}>${escapeHtml((c.flaws || []).join('\n'))}</textarea></div>
      </div>
      ${privateHtml}
      <div class="list-box inventory-box"><div class="section-title"><span>INVENTAIRE</span><small>une ligne par objet</small></div><textarea class="line-textarea public-field" name="inventory" aria-label="Inventaire" placeholder="Sac, lampe torche, trousse de secours…" ${editable ? '' : 'disabled'}>${escapeHtml((c.inventory || []).join('\n'))}</textarea></div>
      <div class="list-box lore-box"><div class="section-title"><span>LORE / NOTES</span><small>informations sur le personnage</small></div><textarea class="line-textarea public-field lore-textarea" name="notes" aria-label="Lore et notes" placeholder="Histoire, objectifs, informations à retenir…" ${editable ? '' : 'disabled'}>${escapeHtml(c.notes || '')}</textarea></div>
      ${editable ? `<div class="form-footer"><span class="save-status" id="save-status">${c.updatedAt ? `Dernière modification · ${formatTime(c.updatedAt)}` : 'Modifications non enregistrées'}</span><button class="button button-primary save-button" type="submit">Enregistrer <span>↗</span></button></div>` : '<div class="readonly-note">Cette fiche appartient à un autre joueur. Le MJ peut la modifier.</div>'}
     </form>
     ${mj ? `<div class="character-admin-footer"><span>Administration du compte : <strong>${escapeHtml(member.user.username)}</strong></span><div class="character-admin-actions"><button id="reset-current-password" class="reset-player-password">Réinitialiser le mot de passe</button><button id="remove-player-character" class="button button-danger">Retirer du groupe</button><button id="delete-player-account" class="button button-danger button-danger-strong">Supprimer le compte</button></div></div>` : ''}
   </article>`;
  const form = $('#character-form');
  if (editable) {
    form.addEventListener('submit', saveCharacter);
    form.addEventListener('input', (event) => {
      const target = event.target;
      if (target.dataset.stat) markCharacterField(`stat:${target.dataset.stat}`);
      else if (target.closest('.private-row')) markCharacterField('privateStats');
      else if (target.name) markCharacterField(target.name);
      if (target.dataset.stat || target.name === 'statPointsBonus') updateAllocationControls(form, c);
    });
    updateAllocationControls(form, c);
  }
  if (mj) {
    $('#reset-current-password').addEventListener('click', () => resetPlayerPasswordModal(member.user.id, member.user.username));
    $('#remove-player-character').addEventListener('click', () => removePlayerFromGroupModal(member.user.id, member.user.username, displayName));
    $('#delete-player-account').addEventListener('click', () => deletePlayerAccountModal(member.user.id, member.user.username));
    $('#add-private-stat').addEventListener('click', () => {
      const list = $('#private-stats');
      list.insertAdjacentHTML('beforeend', privateStatHtml({ name: '', value: 0 }, $$('.private-row', list).length));
      markCharacterField('privateStats');
      const input = $('.private-name-input', list.lastElementChild);
      input.focus();
    });
    $('#private-stats').addEventListener('click', (event) => {
      const button = event.target.closest('.remove-stat');
      if (button) {
        button.closest('.private-row').remove();
        markCharacterField('privateStats');
      }
    });
  }
}

function privateStatHtml(stat, index) {
  return `<div class="private-row"><input class="private-name-input" type="text" maxlength="50" placeholder="Nom de l’indicateur" value="${escapeHtml(stat.name)}" aria-label="Nom de l’indicateur ${index + 1}"><input class="private-input" type="number" min="0" max="999" value="${Number(stat.value || 0)}" aria-label="Valeur de ${escapeHtml(stat.name || 'indicateur')}"><button class="remove-stat" type="button" title="Supprimer cet indicateur" aria-label="Supprimer cet indicateur">×</button></div>`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'à l’instant';
  return `à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

async function saveCharacter(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('.save-button', form);
  const status = $('#save-status', form);
  const formData = new FormData(form);
  const changes = new Set(state.characterChanges);
  const payload = {};
  for (const field of ['firstName', 'name', 'job', 'notes']) {
    if (changes.has(field)) payload[field] = String(formData.get(field) || '');
  }
  if (changes.has('luck')) payload.luck = Number(formData.get('luck'));
  for (const field of ['skills', 'flaws', 'inventory']) {
    if (changes.has(field)) payload[field] = String(formData.get(field) || '').split('\n');
  }
  const changedStats = Object.fromEntries([...changes]
    .filter((field) => field.startsWith('stat:'))
    .map((field) => {
      const stat = field.slice(5);
      return [stat, Number($$('[data-stat]', form).find((input) => input.dataset.stat === stat)?.value)];
    }));
  if (Object.keys(changedStats).length) payload.stats = changedStats;
  if (state.group.role === 'mj' && changes.has('statPointsBonus')) {
    payload.statPointsBonus = Number(formData.get('statPointsBonus'));
  }
  if (state.group.role === 'mj' && changes.has('privateStats')) {
    payload.privateStats = $$('.private-row', form).map((row) => ({ name: $('.private-name-input', row).value, value: Number($('.private-input', row).value) }));
  }
  if (Object.keys(payload).length === 0) return showToast('Aucune modification à enregistrer.');
  button.disabled = true;
  status.textContent = 'Enregistrement…';
  try {
    const saved = await request(`/api/characters/${state.selectedCharacterId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    if (Object.hasOwn(payload, 'notes') && typeof saved.character?.notes !== 'string') {
      throw new Error('Le serveur ne reconnaît pas encore les notes. Mets à jour server.js sur OMV et redémarre le conteneur.');
    }
    state.characterDirty = false;
    state.characterChanges.clear();
    await refreshGroup(state.group.id);
    showToast('Fiche mise à jour');
  } catch (error) { status.textContent = error.message; showToast(error.message); }
  finally { button.disabled = false; }
}

function openModal(content, onReady) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  const backdrop = $('.modal-backdrop');
  $('.modal-close', backdrop)?.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(); });
  onReady?.(backdrop);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function groupModal() {
  if (!confirmUnsavedChanges()) return;
  state.characterDirty = false;
  state.characterChanges.clear();
  openModal(`<div class="modal-header"><div><h2>Créer un dossier</h2><p>Un espace distinct pour un groupe de joueurs et ses fiches.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="group-form"><label class="field-label" for="group-name">Nom du dossier</label><input class="text-input" id="group-name" name="name" required maxlength="70" placeholder="ex. Les brumes de Valombre"><div class="modal-error"></div><button class="button button-primary" type="submit">Créer le dossier <span>↗</span></button></form>`, (root) => {
    $('#group-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name');
      try {
        const data = await request('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
        closeModal();
        state.groups.push(data.group);
        await loadGroup(data.group.id);
        showToast('Dossier créé');
      } catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

function addPlayerModal() {
  if (!confirmUnsavedChanges()) return;
  state.characterDirty = false;
  state.characterChanges.clear();
  const current = state.group;
  openModal(`<div class="modal-header"><div><h2>Ajouter un joueur</h2><p>Crée son compte ou ajoute un compte joueur déjà existant.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="player-form">
    <label class="field-label" for="player-username">Identifiant du joueur</label><input class="text-input" id="player-username" name="username" required minlength="3" maxlength="40" autocomplete="off" placeholder="ex. alex">
    <label class="field-label" for="player-password">Mot de passe initial <span class="form-hint-inline">· requis pour un nouveau compte</span></label><input class="text-input" id="player-password" name="password" type="password" minlength="6" autocomplete="new-password" placeholder="6 caractères minimum">
    <label class="field-label" for="player-stat-points">Points initiaux à attribuer</label><input class="text-input" id="player-stat-points" name="statPointsInitial" type="number" min="24" max="114" step="1" value="60" required><div class="form-help">Budget total des six caractéristiques ; les 4 points minimum de chacune sont inclus.</div>
    <div class="modal-error"></div><button class="button button-primary" type="submit">Ajouter à « ${escapeHtml(current.name)} » <span>↗</span></button>
  </form>`, (root) => {
    $('#player-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      try {
        const result = await request(`/api/groups/${current.id}/players`, { method: 'POST', body: JSON.stringify({ username: data.username, password: data.password, statPointsInitial: Number(data.statPointsInitial) }) });
        closeModal();
        const refreshed = await request('/api/me');
        state.groups = refreshed.groups;
        await loadGroup(current.id);
        if (result.created) credentialModal(data.username, data.password);
        else showToast('Joueur ajouté au dossier');
      } catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

function credentialModal(username, password) {
  openModal(`<div class="modal-header"><div><h2>Compte joueur créé</h2><p>Transmets ces identifiants au joueur de manière privée.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><div class="credential-box">Identifiant&nbsp;: ${escapeHtml(username)}<br>Mot de passe&nbsp;: ${escapeHtml(password)}</div><div class="credential-note">Le mot de passe ne sera plus affiché. Le joueur pourra se connecter depuis un autre navigateur.</div><button class="button button-primary" id="credential-done">Compris <span>↗</span></button>`, (root) => $('#credential-done', root).addEventListener('click', closeModal));
}

function changePasswordModal() {
  openModal(`<div class="modal-header"><div><h2>Changer mon mot de passe</h2><p>Choisis un nouveau mot de passe d’au moins 6 caractères.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="own-password-form">
    <label class="field-label" for="current-password">Mot de passe actuel</label><input class="text-input" id="current-password" name="currentPassword" type="password" required autocomplete="current-password">
    <label class="field-label" for="new-password">Nouveau mot de passe</label><input class="text-input" id="new-password" name="newPassword" type="password" required minlength="6" autocomplete="new-password">
    <label class="field-label" for="confirm-password">Confirmer le nouveau mot de passe</label><input class="text-input" id="confirm-password" name="confirmPassword" type="password" required minlength="6" autocomplete="new-password">
    <div class="modal-error"></div><button class="button button-primary" type="submit">Mettre à jour <span>↗</span></button>
  </form>`, (root) => {
    $('#own-password-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.newPassword !== values.confirmPassword) return $('.modal-error', root).textContent = 'Les deux nouveaux mots de passe ne correspondent pas.';
      try {
        await request('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
        closeModal();
        showToast('Mot de passe mis à jour');
      } catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

function resetPlayerPasswordModal(userId, username) {
  const groupId = state.group.id;
  openModal(`<div class="modal-header"><div><h2>Réinitialiser le mot de passe</h2><p>Compte joueur : <strong>${escapeHtml(username)}</strong>. Communique le nouveau mot de passe en privé.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="reset-password-form">
    <label class="field-label" for="reset-new-password">Nouveau mot de passe temporaire</label><input class="text-input" id="reset-new-password" name="newPassword" type="password" required minlength="6" autocomplete="new-password">
    <label class="field-label" for="reset-confirm-password">Confirmer le mot de passe</label><input class="text-input" id="reset-confirm-password" name="confirmPassword" type="password" required minlength="6" autocomplete="new-password">
    <div class="modal-error"></div><button class="button button-primary" type="submit">Réinitialiser <span>↗</span></button>
  </form>`, (root) => {
    $('#reset-password-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.newPassword !== values.confirmPassword) return $('.modal-error', root).textContent = 'Les deux mots de passe ne correspondent pas.';
      try {
        await request(`/api/groups/${groupId}/players/${userId}/password`, { method: 'POST', body: JSON.stringify({ newPassword: values.newPassword }) });
        resetPasswordSuccessModal(username, values.newPassword);
      } catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

function resetPasswordSuccessModal(username, password) {
  openModal(`<div class="modal-header"><div><h2>Mot de passe réinitialisé</h2><p>Les anciennes sessions de ce joueur ont été déconnectées.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><div class="credential-box">Identifiant&nbsp;: ${escapeHtml(username)}<br>Nouveau mot de passe&nbsp;: ${escapeHtml(password)}</div><div class="credential-note">Le mot de passe n’est affiché qu’une fois. Transmets-le au joueur en privé.</div><button class="button button-primary" id="reset-password-done">Compris <span>↗</span></button>`, (root) => $('#reset-password-done', root).addEventListener('click', closeModal));
}

function removePlayerFromGroupModal(userId, username, characterName) {
  const groupId = state.group.id;
  const groupName = state.group.name;
  openModal(`<div class="modal-header"><div><h2>Retirer ce personnage du groupe ?</h2><p>La fiche de <strong>${escapeHtml(characterName)}</strong> sera supprimée de « ${escapeHtml(groupName)} ».</p></div><button class="modal-close" aria-label="Fermer">×</button></div><div class="credential-note">Le compte de ${escapeHtml(username)} et ses personnages dans les autres groupes ne seront pas supprimés.</div><div class="modal-actions"><button class="button button-quiet modal-cancel">Annuler</button><button class="button button-danger" id="confirm-remove-player">Retirer du groupe</button></div>`, (root) => {
    $('.modal-cancel', root).addEventListener('click', closeModal);
    $('#confirm-remove-player', root).addEventListener('click', async () => {
      try {
        await request(`/api/groups/${groupId}/players/${userId}`, { method: 'DELETE' });
        closeModal();
        await enterApp(groupId);
        showToast('Personnage retiré du groupe');
      } catch (error) { showToast(error.message); }
    });
  });
}

function deletePlayerAccountModal(userId, username) {
  openModal(`<div class="modal-header"><div><h2>Supprimer le compte joueur ?</h2><p>Cette action efface son compte et tous ses personnages, dans tous les groupes.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="delete-player-form"><label class="field-label" for="delete-player-confirm">Pour confirmer, saisis son identifiant : <strong>${escapeHtml(username)}</strong></label><input class="text-input" id="delete-player-confirm" name="confirmation" required autocomplete="off"><div class="modal-error"></div><div class="modal-actions"><button class="button button-quiet modal-cancel" type="button">Annuler</button><button class="button button-danger button-danger-strong" type="submit">Supprimer définitivement</button></div></form>`, (root) => {
    $('.modal-cancel', root).addEventListener('click', closeModal);
    $('#delete-player-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const confirmation = new FormData(event.currentTarget).get('confirmation');
      if (confirmation !== username) return $('.modal-error', root).textContent = 'L’identifiant ne correspond pas.';
      try {
        await request(`/api/users/${userId}`, { method: 'DELETE' });
        closeModal();
        const groupId = state.group.id;
        await enterApp(groupId);
        showToast('Compte joueur et personnages supprimés');
      } catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

async function renameGroup() {
  if (!confirmUnsavedChanges()) return;
  state.characterDirty = false;
  state.characterChanges.clear();
  const group = state.group;
  openModal(`<div class="modal-header"><div><h2>Renommer le dossier</h2><p>Le nom sera mis à jour pour tous ses membres.</p></div><button class="modal-close" aria-label="Fermer">×</button></div><form id="rename-form"><label class="field-label" for="rename-input">Nom du dossier</label><input class="text-input" id="rename-input" name="name" required maxlength="70" value="${escapeHtml(group.name)}"><div class="modal-error"></div><button class="button button-primary" type="submit">Enregistrer <span>↗</span></button></form>`, (root) => {
    $('#rename-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name');
      try { await request(`/api/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); closeModal(); await enterApp(); showToast('Dossier renommé'); }
      catch (error) { $('.modal-error', root).textContent = error.message; }
    });
  });
}

$('#new-group').addEventListener('click', groupModal);
$('#welcome-new-group').addEventListener('click', groupModal);
$('#add-player').addEventListener('click', addPlayerModal);
$('#empty-add-player').addEventListener('click', addPlayerModal);
$('#rename-group').addEventListener('click', renameGroup);
$('#back-to-group-overview').addEventListener('click', showGroupOverview);
$('#change-password').addEventListener('click', changePasswordModal);
$('#player-character-switcher').addEventListener('change', (event) => loadGroup(event.currentTarget.value));
$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = !$('#app-view').classList.contains('sidebar-collapsed');
  localStorage.setItem('table-sidebar-collapsed', String(collapsed));
  applySidebarState();
});
$('#mobile-menu').addEventListener('click', () => {
  $('#app-view').classList.add('sidebar-open');
  $('#sidebar-scrim').classList.remove('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'true');
});
$('#sidebar-scrim').addEventListener('click', closeMobileSidebar);
$('#logout').addEventListener('click', async () => {
  if (!confirmUnsavedChanges()) return;
  disconnectEvents();
  await request('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.user = null; state.groups = []; state.group = null;
  showAuth().catch((error) => showToast(error.message));
});

// La session est vérifiée avant d'afficher l'écran de connexion pour éviter un clignotement.
enterApp().catch(async (error) => {
  if (error.message.includes('Connecte-toi')) return showAuth();
  showToast(error.message);
});
