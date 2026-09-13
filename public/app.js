/* Ashvault client.
 *
 * The client renders and animates. It never decides anything: every roll,
 * every outcome, every state change arrives from the server already resolved
 * (GAME_DESIGN.md §1.5). There is deliberately no game logic in this file —
 * the dice animation in dice.js tumbles toward a result it was handed.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    account: null,
    sessionId: null,
    catalogue: null,
    statPool: [],
    weaponId: null,
    backgroundId: null,
    assignment: {},
    snapshot: null,
    history: [],
    historyIndex: -1,
    busy: false,
  };

  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

  // ----------------------------------------------------------------- net

  async function api(path, body, method = 'POST') {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ error: 'Malformed response from the server.' }));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }

  // --------------------------------------------------------- pocket saves
  // A Pocket Save belongs to the player, rather than this server process.
  // It is intentionally transparent, checksum-protected JSON: good for an
  // itch.io backup, but never a source of truth for future ranked/social play.
  const POCKET_STORAGE_KEY = 'ashvault-pocket-save-v1';
  const POCKET_PREFIX = 'ASH1-';

  function pocketChecksum(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }

  async function packPocket(text) {
    const source = new TextEncoder().encode(text);
    if (!window.CompressionStream) return `J${bytesToBase64Url(source)}`;
    const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return `G${bytesToBase64Url(packed)}`;
  }

  async function unpackPocket(body) {
    const format = body[0];
    const bytes = base64UrlToBytes(body.slice(1));
    if (format === 'J') return new TextDecoder().decode(bytes);
    if (format !== 'G' || !window.DecompressionStream) throw new Error('This browser cannot read that Pocket Save.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  async function encodePocket(payload) {
    const body = await packPocket(JSON.stringify(payload));
    return `${POCKET_PREFIX}${body}.${pocketChecksum(body)}`;
  }

  async function decodePocket(code) {
    const cleaned = String(code ?? '').trim().replace(/\s+/g, '');
    if (!cleaned.startsWith(POCKET_PREFIX)) throw new Error('That is not an Ashvault Pocket Save.');
    const [body, checksum, extra] = cleaned.slice(POCKET_PREFIX.length).split('.');
    if (!body || !checksum || extra || checksum !== pocketChecksum(body)) {
      throw new Error('That Pocket Save does not match its checksum. Copy the whole code again.');
    }
    try {
      const payload = JSON.parse(await unpackPocket(body));
      if (payload?.version !== 1 || !payload.save) throw new Error('bad payload');
      return payload;
    } catch {
      throw new Error('That Pocket Save could not be read.');
    }
  }

  function rememberPocket(payload) {
    try { localStorage.setItem(POCKET_STORAGE_KEY, JSON.stringify(payload)); } catch { /* browser storage is optional */ }
  }

  function savedPocket() {
    try { return JSON.parse(localStorage.getItem(POCKET_STORAGE_KEY) ?? 'null'); } catch { return null; }
  }

  async function backupCurrentRun() {
    if (!state.account) return null;
    const payload = await api('/api/session/export', null, 'GET');
    rememberPocket(payload);
    return payload;
  }

  // ------------------------------------------------------------ creation

  async function boot() {
    if (location.protocol === 'file:') {
      renderAuth();
      $('auth-error').textContent = 'Ashvault needs its game server. Open http://localhost:3000 — not this file directly.';
      $('auth-submit').disabled = true;
      $('auth-switch').disabled = true;
      return;
    }
    try {
      const identity = await api('/api/auth/me', null, 'GET');
      state.account = identity.account;
      await loadRun();
    } catch (error) {
      renderAuth();
    }
  }

  async function loadRun() {
    const data = await api('/api/session');
    state.account = data.account ?? state.account;
    state.sessionId = data.sessionId;
    state.catalogue = data.catalogue;
    state.statPool = data.statPool;
    state.snapshot = data.state;
    if (data.state?.state === 'creation') renderCreation();
    else if (data.state?.state === 'victory') { showScreen('hub'); renderHub(); }
    else { enterGame(data); }
  }

  let restoring = false;
  function renderAuth() {
    showScreen('auth');
    $('auth-title').textContent = restoring ? 'Return to the undercroft' : 'Claim your name';
    $('auth-note').textContent = restoring
      ? 'Enter the Vault Key you were shown when the account was created.'
      : 'No password. Your browser remembers you; keep the Vault Key shown once after creation.';
    $('auth-submit').textContent = restoring ? 'Restore account' : 'Create account';
    $('auth-switch').textContent = restoring ? 'I need a new account' : 'I have a Vault Key';
    $('auth-name-wrap').classList.toggle('hidden', restoring);
    $('auth-key-wrap').classList.toggle('hidden', !restoring);
    $('key-reveal').classList.add('hidden');
  }

  $('auth-switch').addEventListener('click', () => { restoring = !restoring; $('auth-error').textContent = ''; renderAuth(); });
  $('auth-submit').addEventListener('click', async () => {
    try {
      const data = await api(restoring ? '/api/auth/restore' : '/api/auth/register', restoring
        ? { vaultKey: $('auth-key').value.trim().toUpperCase() }
        : { displayName: $('auth-name').value.trim() });
      state.account = data.account;
      if (data.vaultKey) {
        $('key-reveal-text').innerHTML = `<strong>Save this Vault Key.</strong><code>${escape(data.vaultKey)}</code><span>It restores this account on another device. Your shareable party code is <b>${escape(data.account.friendCode)}</b>.</span>`;
        $('key-reveal').classList.remove('hidden');
        return;
      }
      await loadRun();
    } catch (error) { $('auth-error').textContent = error.message; }
  });
  $('key-continue').addEventListener('click', () => loadRun().catch((error) => { $('auth-error').textContent = error.message; }));

  function setPocketMessage(message, error = false) {
    const el = $('pocket-message');
    el.textContent = message;
    el.classList.toggle('error', error);
  }
  async function openPocket() {
    const saved = savedPocket();
    $('pocket-dialog').classList.remove('hidden');
    $('pocket-output').value = saved ? await encodePocket(saved) : '';
    $('pocket-input').value = '';
    setPocketMessage(saved ? 'A fresh backup is already stored in this browser.' : 'Generate a code after you have begun a run.');
  }
  function closePocket() { $('pocket-dialog').classList.add('hidden'); }
  $('pocket-open-auth').addEventListener('click', () => openPocket().catch((error) => setPocketMessage(error.message, true)));
  $('pocket-close').addEventListener('click', closePocket);
  $('pocket-generate').addEventListener('click', async () => {
    try {
      const payload = await backupCurrentRun();
      if (!payload) throw new Error('Create or restore an account before generating a save.');
      $('pocket-output').value = await encodePocket(payload);
      setPocketMessage('Pocket Save generated. Copy it somewhere safe.');
    } catch (error) { setPocketMessage(error.message, true); }
  });
  $('pocket-copy').addEventListener('click', async () => {
    const value = $('pocket-output').value;
    if (!value) return setPocketMessage('Generate a save code first.', true);
    try { await navigator.clipboard.writeText(value); setPocketMessage('Pocket Save copied.'); }
    catch { $('pocket-output').focus(); $('pocket-output').select(); setPocketMessage('Code selected — copy it with your device controls.'); }
  });
  $('pocket-restore').addEventListener('click', async () => {
    try {
      const payload = await decodePocket($('pocket-input').value);
      // When a free playtest server has forgotten an account, the Pocket Save
      // creates a fresh identity and then restores the character beneath it.
      if (!state.account) {
        const created = await api('/api/auth/register', { displayName: payload.account?.displayName ?? 'Recovered Wanderer' });
        state.account = created.account;
      }
      await api('/api/session/import', { save: payload.save });
      rememberPocket(payload);
      closePocket();
      await loadRun();
    } catch (error) { setPocketMessage(error.message, true); }
  });

  function showScreen(name) {
    for (const id of ['auth', 'creation', 'game', 'hub']) {
      $(id).classList.toggle('hidden', id !== name);
    }
  }

  function renderCreation() {
    showScreen('creation');

    $('weapon-list').innerHTML = state.catalogue.weapons
      .map(
        (c) => `<button type="button" class="chip" data-kind="weapon" data-id="${c.id}" aria-pressed="false">
          <span class="chip-name">${c.name}</span>
          <span class="chip-meta">d${c.hitDie} · ${c.primary.toUpperCase()}${c.resource ? ` · ${c.resource}` : ''}</span>
        </button>`
      )
      .join('');

    $('background-list').innerHTML = state.catalogue.backgrounds
      .map(
        (b) => `<button type="button" class="chip" data-kind="background" data-id="${b.id}" aria-pressed="false">
          <span class="chip-name">${b.name}</span>
          <span class="chip-meta">+1 ${Object.keys(b.abilityBonus)[0].toUpperCase()} · ${b.skillProficiency}</span>
        </button>`
      )
      .join('') +
      // Held-back backgrounds are shown, unselectable, so the shipped grid reads
      // as deliberately scoped rather than as all there will ever be.
      (state.catalogue.comingSoon ?? [])
        .map(
          (b) => `<span class="chip chip-locked" aria-disabled="true" title="${b.note}">
          <span class="chip-name">${b.name}</span>
          <span class="chip-meta">a later chapter</span>
        </span>`
        )
        .join('');

    renderAssign();
    renderModel();
    markForbiddenChoices();
    updateBeginButton();
  }

  /**
   * The figure in the frame, and the identity the current pair produces.
   * There are no classes: the weapon and the background together generate the
   * title, so the player watches it resolve as they choose (§2).
   */
  function renderModel() {
    const weapon = state.catalogue.weapons.find((w) => w.id === state.weaponId);
    const bg = state.catalogue.backgrounds.find((b) => b.id === state.backgroundId);

    $('model').innerHTML = window.Portrait.render(
      weapon?.figure ?? 'armoured',
      state.backgroundId,
      { label: weapon ? `${weapon.name} figure` : 'an unchosen figure' }
    );
    $('model').style.opacity = weapon ? '1' : '0.4';

    const refusal = weapon && bg ? bg.forbids?.[weapon.id] ?? null : null;
    const entry = weapon && bg && !refusal ? state.catalogue.titles[weapon.id]?.[bg.id] : null;
    const title = entry?.title ?? null;

    if (refusal) {
      $('model-name').textContent = 'That will not do';
      $('model-tag').textContent = `${bg.name} · ${weapon.name}`;
      $('model-blurb').textContent = refusal;
      $('model-hook').textContent = '';
      $('model').style.opacity = '0.25';
      return;
    }

    if (title) {
      $('model-name').textContent = title;
      $('model-tag').textContent = `${bg.name} · ${weapon.name}`;
      // The gloss is the payoff of hand-writing all 90 — it says who this
      // specific pairing is, which a generated name never could.
      $('model-blurb').textContent = entry.gloss;
      $('model-hook').textContent = bg.hubHook ?? '';
      return;
    }
    if (weapon) {
      $('model-name').textContent = weapon.name;
      $('model-tag').textContent = 'Now choose where you came from';
    } else if (bg) {
      $('model-name').textContent = bg.name;
      $('model-tag').textContent = 'Now choose what you carry';
    } else {
      $('model-name').textContent = 'Nobody yet';
      $('model-tag').textContent = 'A weapon and a past make a person';
    }

    $('model-blurb').textContent = bg ? bg.blurb : weapon ? weapon.blurb : '';
    $('model-hook').textContent = weapon && bg ? `${weapon.blurb}` : '';
  }

  function renderAssign() {
    const options = state.statPool.map((p, i) => `<option value="${i}">${p.total}</option>`).join('');

    $('assign').innerHTML = ABILITIES.map(
      (ability) => `<div class="assign-row">
        <span class="ability">${ability.toUpperCase()}</span>
        <select data-ability="${ability}" aria-label="${ability} score">${options}</select>
        <span class="dice-mini" data-dice="${ability}"></span>
        <span class="result" data-result="${ability}"></span>
      </div>`
    ).join('');

    document.querySelectorAll('#assign select').forEach((sel, i) => {
      sel.value = String(i);
      sel.addEventListener('change', () => {
        readAssignment();
        renderAssignResults();
        updateBeginButton();
      });
    });

    readAssignment();
    renderAssignResults();
  }

  function readAssignment() {
    state.assignment = {};
    document.querySelectorAll('#assign select').forEach((sel) => {
      state.assignment[sel.dataset.ability] = Number(sel.value);
    });
  }

  /** Show the four dice behind each score, and the final total after bonuses. */
  function renderAssignResults() {
    const cls = state.catalogue.weapons.find((c) => c.id === state.weaponId);
    const bg = state.catalogue.backgrounds.find((b) => b.id === state.backgroundId);

    for (const ability of ABILITIES) {
      const index = state.assignment[ability];
      const roll = state.statPool[index];
      const base = roll?.total ?? 0;
      const bonus = (cls?.abilityBonus?.[ability] ?? 0) + (bg?.abilityBonus?.[ability] ?? 0);
      const total = Math.min(20, base + bonus);
      const mod = Math.floor((total - 10) / 2);

      const diceEl = document.querySelector(`[data-dice="${ability}"]`);
      if (diceEl && roll) window.Dice.still(diceEl, roll);

      const el = document.querySelector(`[data-result="${ability}"]`);
      if (el) {
        el.innerHTML = `${total}${bonus ? ` <span class="mod">+${bonus}</span>` : ''} <span class="mod">${mod >= 0 ? '+' : ''}${mod}</span>`;
      }
    }
  }

  const duplicateAssignment = () => new Set(Object.values(state.assignment)).size !== 6;

  /** The refusal text for the current pair, or null if the pair is legal. */
  function currentRefusal() {
    if (!state.weaponId || !state.backgroundId) return null;
    const bg = state.catalogue.backgrounds.find((b) => b.id === state.backgroundId);
    return bg?.forbids?.[state.weaponId] ?? null;
  }

  function markForbiddenChip(chip, reason) {
    const forbidden = Boolean(reason);
    chip.classList.toggle('chip-forbidden', forbidden);
    chip.disabled = forbidden;
    chip.setAttribute('aria-disabled', String(forbidden));
    if (reason) chip.title = reason;
    else chip.removeAttribute('title');
  }

  /**
   * A prohibition belongs to the pair, not to one side of the picker. Mirror
   * the same rule in both directions so players never choose a half only to
   * be told afterwards that it cannot become a character.
   */
  function markForbiddenChoices() {
    const chosenBackground = state.catalogue.backgrounds.find((b) => b.id === state.backgroundId);
    for (const chip of document.querySelectorAll('.chip[data-kind="weapon"]')) {
      markForbiddenChip(chip, chosenBackground?.forbids?.[chip.dataset.id] ?? null);
    }
    for (const chip of document.querySelectorAll('.chip[data-kind="background"]')) {
      const background = state.catalogue.backgrounds.find((b) => b.id === chip.dataset.id);
      markForbiddenChip(chip, background?.forbids?.[state.weaponId] ?? null);
    }
  }

  function updateBeginButton() {
    const name = $('char-name').value.trim();
    const refusal = currentRefusal();
    const ready = Boolean(
      state.weaponId && state.backgroundId && name && !duplicateAssignment() && !refusal
    );
    $('begin').disabled = !ready;
    $('creation-error').textContent = refusal
      ? refusal
      : duplicateAssignment()
        ? 'Each rolled score can only be assigned once.'
        : '';
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.disabled || chip.getAttribute('aria-disabled') === 'true') return;
    const { kind, id } = chip.dataset;
    if (kind === 'weapon') state.weaponId = id;
    if (kind === 'background') state.backgroundId = id;
    document.querySelectorAll(`.chip[data-kind="${kind}"]`).forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.id === id));
    });
    renderModel();
    renderAssignResults();
    markForbiddenChoices();
    updateBeginButton();
  });

  $('char-name').addEventListener('input', updateBeginButton);

  $('begin').addEventListener('click', async () => {
    try {
      const data = await api('/api/character', {
        sessionId: state.sessionId,
        name: $('char-name').value.trim(),
        weaponId: state.weaponId,
        backgroundId: state.backgroundId,
        assignment: state.assignment,
      });
      enterGame(data);
      backupCurrentRun().catch(() => {});
    } catch (err) {
      $('creation-error').textContent = err.message;
    }
  });

  function enterGame(data) {
    showScreen('game');
    $('log').innerHTML = '';
    $('tray').innerHTML = '';
    appendEntries(data.entries);
    state.snapshot = data.state;
    syncAmbience();
    renderSheet();
    backupCurrentRun().catch(() => {});
    $('prompt').focus();
  }

  // ---------------------------------------------------------------- log

  /**
   * Pick a sound for a log line.
   *
   * The server sends prose, not sound ids, so this reads the line the same way
   * the player does. That keeps audio entirely in the client — the game logic
   * never has to know sound exists — at the cost of matching on text. The
   * patterns below are deliberately anchored to phrasing the engine controls.
   */
  function cueFor(entry) {
    const S = window.Sound;
    if (!S) return;
    const t = entry.text;

    if (entry.roll) {
      const r = entry.roll;
      if (r.outcome === 'crit') return S.play('crit');
      if (r.outcome === 'hit') return S.play('hit');
      if (r.outcome === 'miss' || r.outcome === 'fumble') return S.play('miss');
      return S.play('settle');
    }
    if (/is destroyed\.|comes apart\./.test(t)) return S.play('kill');
    if (/gets up\./.test(t)) return S.play('bell');
    if (/You are dead|you died/i.test(t)) return S.play('death');
    if (/The room is yours|The way is open/.test(t)) return S.play('victory');
    if (/You are now level/.test(t)) return S.play('levelUp');
    if (/\+\d+ HP|restored|closes over/.test(t)) return S.play('heal');
    if (/grinds shut|stays shut|seals shut/.test(t)) return S.play('door');
    if (/portal|Ashvault opens/i.test(t)) return S.play('portal');
    if (entry.kind === 'danger') return S.play('hurt');
    return undefined;
  }

  /** Move the ambience bed when the room's zone changes. */
  function syncAmbience() {
    const S = window.Sound;
    if (!S) return;
    const snap = state.snapshot;
    if (!snap || snap.state === 'dead') return S.ambience('none');
    S.ambience(S.zoneFor(snap.room));
  }

  function appendEntries(entries) {
    const log = $('log');
    let lastRoll = null;

    for (const entry of entries) {
      const p = document.createElement('p');
      p.className = `line-${entry.kind}`;
      p.textContent = entry.text;
      log.appendChild(p);
      if (entry.roll) lastRoll = entry.roll;
      cueFor(entry);
    }
    log.scrollTop = log.scrollHeight;

    // The tray animates the most consequential roll of the batch: an attack or
    // a save the player is waiting on, else whatever rolled last.
    const notable = entries.filter((e) => e.roll).map((e) => e.roll);
    const featured =
      notable.find((r) => r.kind === 'attack') ??
      notable.find((r) => r.kind === 'save' || r.kind === 'check') ??
      lastRoll;

    if (featured) {
      window.Dice.show($('tray'), featured, {
        onSettle: () => { log.scrollTop = log.scrollHeight; },
      });
    }
  }

  // --------------------------------------------------------------- sound

  (function wireSound() {
    const btn = $('mute');
    if (!btn || !window.Sound) return;

    const paint = () => {
      const m = window.Sound.isMuted();
      btn.setAttribute('aria-pressed', String(m));
      btn.textContent = m ? '♪' : '♫';
      btn.title = m ? 'Sound off (M)' : 'Sound on (M)';
    };

    btn.addEventListener('click', () => {
      window.Sound.setMuted(!window.Sound.isMuted());
      paint();
      if (!window.Sound.isMuted()) window.Sound.play('tick');
    });

    // M toggles, but never while the player is typing a command into the prompt.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      window.Sound.setMuted(!window.Sound.isMuted());
      paint();
    });

    paint();
  })();

  // -------------------------------------------------------------- prompt

  $('prompt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('prompt');
    const value = input.value.trim();
    if (!value || state.busy) return;

    state.history.push(value);
    state.historyIndex = state.history.length;
    input.value = '';
    await send(value);
  });

  async function send(input) {
    state.busy = true;
    try {
      const lower = input.toLowerCase();
      const isRestart = lower === 'restart' || lower === 'new';
      const data = await api(isRestart ? '/api/restart' : '/api/command', {
        sessionId: state.sessionId,
        input,
      });
      appendEntries(data.entries);
      state.snapshot = data.state;
      syncAmbience();

      if (data.state.state === 'creation') {
        state.statPool = data.statPool ?? state.statPool;
        state.catalogue = data.catalogue ?? state.catalogue;
        state.weaponId = null;
        state.backgroundId = null;
        $('char-name').value = '';
        renderCreation();
        return;
      }

      renderSheet();
      if (data.state.state === 'victory') renderHub();
      backupCurrentRun().catch(() => {});
    } catch (err) {
      appendEntries([{ kind: 'error', text: err.message }]);
    } finally {
      state.busy = false;
      if (!$('game').classList.contains('hidden')) $('prompt').focus();
    }
  }

  $('prompt').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!state.history.length) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') state.historyIndex = Math.max(0, state.historyIndex - 1);
    else state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
    $('prompt').value = state.history[state.historyIndex] ?? '';
  });

  // --------------------------------------------------------------- sheet

  function bar(kind, label, value, max, extraClass = '') {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="bar-${kind} ${extraClass}">
      <div class="bar-label"><span>${label}</span><span class="val">${value} / ${max}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }

  function vitalBars(c) {
    const xpMax = c.xpToNext === null ? c.xp : c.xp + c.xpToNext;
    return (
      bar('hp', 'Health', c.hp, c.hpMax, c.hp / Math.max(1, c.hpMax) <= 0.3 ? 'low' : '') +
      (c.resource ? bar('res', c.resource.name, c.resource.current, c.resource.max) : '') +
      bar('xp', 'Experience', c.xp, xpMax)
    );
  }

  function renderSheet() {
    const s = state.snapshot;
    const c = s?.character;
    if (!c) return;

    $('sheet-portrait').innerHTML = window.Portrait.render(c.figure, c.backgroundId, {
      label: `${c.name}, ${c.weaponName}`,
    });
    $('sheet-name').textContent = c.name;
    $('sheet-class').textContent = `Level ${c.level} ${c.title} · ${c.backgroundName} with a ${c.weaponName}`;
    $('sheet-badges').innerHTML =
      (c.hubUnlocked ? '<span class="badge">Hub-unlocked</span>' : '') +
      (c.status === 'dead' ? '<span class="badge dead">Dead</span>' : '');

    $('sheet-bars').innerHTML = vitalBars(c);
    $('sheet-account').innerHTML = state.account?.friendCode
      ? `<span>Friend code</span><code>${escape(state.account.friendCode)}</code><small>Share this to form a party.</small><button id="pocket-open-sheet" type="button" class="ghost-btn">Pocket Save</button>`
      : '';

    $('pocket-open-sheet')?.addEventListener('click', () => openPocket().catch((error) => setPocketMessage(error.message, true)));

    const enc = s.encounter;
    $('sheet-room').innerHTML = s.room
      ? `<h3>${escape(s.room.zoneName)}</h3>
         <div class="kv"><span>${escape(s.room.name)}</span>${enc?.yourTurn ? '<span class="turn-flag">Your turn</span>' : ''}</div>
         <div class="kv"><span>Armour class</span><span class="v">${c.ac}</span></div>
         <div class="kv"><span>Attack</span><span class="v">+${c.attackBonus} · ${escape(c.weapon)}</span></div>
         <div class="kv"><span>Marks</span><span class="v">${c.marks}</span></div>
         <div class="kv"><span>Exits</span><span class="v">${s.room.exits.map((e) => e.toUpperCase()).join(' · ') || '—'}</span></div>
         ${s.room.searchable ? '<div class="kv"><span>Unsearched</span><span class="v">SEARCH</span></div>' : ''}
         ${s.room.shrine && !s.room.shrineUsed ? `<div class="kv"><span>${s.room.camp ? 'Camp fire' : 'Shrine'}</span><span class="v">REST</span></div>` : ''}`
      : '';

    $('sheet-enemies').innerHTML =
      enc && enc.enemies.length
        ? `<h3>Room · round ${enc.round}</h3>` +
          enc.enemies
            .map((e) => {
              const pct = Math.max(0, (e.hp / e.hpMax) * 100);
              const tags = [e.marked ? 'marked' : '', e.burning ? 'burning' : '', e.phaseName ?? ''].filter(Boolean);
              return `<div class="enemy ${e.alive ? '' : 'dead'} ${e.marked ? 'marked' : ''}">
                <div class="enemy-name"><span>${escape(e.label)}</span><span class="hp">${e.hp}/${e.hpMax}</span></div>
                <div class="enemy-track"><div class="enemy-fill" style="width:${pct}%"></div></div>
                ${tags.length ? `<span class="enemy-tag">${escape(tags.join(' · '))}</span>` : ''}
              </div>`;
            })
            .join('') +
          // Your Thrall is the thing standing between you and the room, so it
          // needs its HP on screen as plainly as any enemy's.
          (enc.thrall
            ? `<div class="enemy thrall ${enc.thrall.hp > 0 ? '' : 'dead'}">
                <div class="enemy-name"><span>${escape(enc.thrall.label)}</span><span class="hp">${enc.thrall.hp}/${enc.thrall.hpMax}</span></div>
                <div class="enemy-track"><div class="enemy-fill" style="width:${Math.max(0, (enc.thrall.hp / enc.thrall.hpMax) * 100)}%"></div></div>
                <span class="enemy-tag">${enc.thrall.hp > 0 ? 'yours · drawing fire' : 'fallen'}</span>
              </div>`
            : '')
        : '';

    $('sheet-abilities').innerHTML = c.known.length
      ? '<h3>Abilities</h3>' +
        c.known
          .map(
            (a) => `<div class="known ${a.spent ? 'spent' : ''}">
              <span class="n">${escape(a.name)}</span>
              <span class="c">${a.type}${a.cost ? ` · ${a.cost}` : ''}${a.spent ? ' · spent' : ''}</span>
              <span class="t">${escape(a.text)}</span>
            </div>`
          )
          .join('')
      : '';

    $('sheet-inventory').innerHTML = c.inventory.length
      ? '<h3>Carried</h3>' +
        c.inventory
          .map(
            (i) => `<div class="item ${i.rarity}">
              <span class="n">${escape(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</span>
              ${i.equipped ? '<span class="eq">equipped</span>' : ''}
            </div>`
          )
          .join('')
      : '<h3>Carried</h3><div class="item"><span>Nothing at all.</span></div>';

    $('sheet-stats').innerHTML =
      '<h3>Abilities</h3><div class="abilities-grid">' +
      ABILITIES.map(
        (a) => `<div class="ability-box">
          <span class="ab">${a.toUpperCase()}</span>
          <span class="sc">${c.abilities[a]}</span>
          <span class="md">${c.mods[a] >= 0 ? '+' : ''}${c.mods[a]}</span>
        </div>`
      ).join('') +
      '</div>';
  }

  // ----------------------------------------------------------------- hub

  /**
   * Ashvault. The city itself is Phase 3 — chat, parties and the vault are
   * present as clearly-labelled inactive surfaces rather than fake features,
   * so the shape of the hub is visible without pretending it works yet.
   */
  function renderHub() {
    const c = state.snapshot?.character;
    if (!c) return;

    $('hub-portrait').innerHTML = window.Portrait.render(c.figure, c.backgroundId, {
      label: `${c.name}, ${c.weaponName}`,
    });
    $('hub-name').textContent = c.name;
    $('hub-tag').textContent = `Level ${c.level} ${c.title} · ${c.backgroundName} with a ${c.weaponName}`;
    $('hub-vitals').innerHTML = vitalBars(c) +
      `<div class="kv"><span>Marks</span><span class="v">${c.marks}</span></div>
       <div class="kv"><span>Carrying</span><span class="v">${c.inventory.length} items</span></div>
       ${state.account?.friendCode ? `<div class="kv"><span>Friend code</span><code>${escape(state.account.friendCode)}</code></div>` : ''}`;

    $('hub-players').innerHTML = [
      { name: c.name, meta: `${c.weaponName} ${c.level}`, you: true },
      { name: 'Vess Coldhand', meta: 'Banker' },
      { name: 'Otho Pell', meta: 'Goods' },
      { name: 'Sister Ambril', meta: 'Shrine' },
      { name: 'The Tallyman', meta: 'Bounties' },
    ]
      .map(
        (p) => `<li><span class="${p.you ? 'you' : ''}">${escape(p.name)}${p.you ? ' (you)' : ''}</span><span class="lvl">${escape(p.meta)}</span></li>`
      )
      .join('');

    showScreen('hub');
  }

  $('hub-return').addEventListener('click', () => {
    showScreen('game');
    $('prompt').focus();
  });

  function escape(str) {
    return String(str).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // ------------------------------------------------- automated test hooks
  //
  // This is a DOM text game, not a canvas game, so there is no frame loop and
  // no advanceTime. The equivalent hooks are: read the whole state as text,
  // and drive the parser directly.

  window.render_game_to_text = function renderGameToText() {
    const s = state.snapshot;
    const c = s?.character;
    const screen = ['creation', 'game', 'hub'].find((id) => !$(id).classList.contains('hidden'));
    const payload = {
      screen,
      mode: s?.state ?? 'creation',
      room: s?.room
        ? { id: s.room.id, name: s.room.name, zone: s.room.zoneName, exits: s.room.exits, searchable: s.room.searchable, shrine: s.room.shrine && !s.room.shrineUsed }
        : null,
      character: c
        ? {
            name: c.name, title: c.title, weapon: c.weaponName, figure: c.figure, background: c.backgroundName,
            level: c.level, xp: c.xp, xpToNext: c.xpToNext,
            hp: c.hp, hpMax: c.hpMax, ac: c.ac, marks: c.marks,
            weapon: c.weapon, attackBonus: c.attackBonus,
            resource: c.resource ? { name: c.resource.name, current: c.resource.current, max: c.resource.max } : null,
            abilities: c.abilities, status: c.status, hubUnlocked: c.hubUnlocked,
            known: c.known.map((a) => `${a.name}${a.spent ? ' (spent)' : ''}`),
            inventory: c.inventory.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}${i.equipped ? ' (equipped)' : ''}`),
          }
        : null,
      encounter: s?.encounter
        ? {
            active: s.encounter.active, round: s.encounter.round, yourTurn: s.encounter.yourTurn,
            actionUsed: s.encounter.actionUsed, bonusUsed: s.encounter.bonusUsed,
            onPlinth: s.encounter.onPlinth, hidden: s.encounter.hidden,
            enemies: s.encounter.enemies.map((e) => ({ label: e.label, hp: e.hp, hpMax: e.hpMax, ac: e.ac, alive: e.alive, marked: e.marked, phase: e.phaseName })),
            thrall: s.encounter.thrall,
          }
        : null,
      ui: {
        portraitRendered: Boolean(document.querySelector('.portrait')),
        diceInTray: $('tray').querySelectorAll('.die').length,
        trayTotal: $('tray').querySelector('.die-total')?.textContent ?? null,
      },
      death: s?.death ?? null,
      lastLines: Array.from($('log').querySelectorAll('p')).slice(-12).map((p) => `[${p.className.replace('line-', '')}] ${p.textContent}`),
    };
    return JSON.stringify(payload);
  };

  window.__submitCommand = async function submitCommand(text) {
    await send(String(text));
    return window.render_game_to_text();
  };

  window.__createCharacter = async function createCharacter(opts = {}) {
    const data = await api('/api/character', {
      sessionId: state.sessionId,
      name: opts.name ?? 'Testfellow',
      weaponId: opts.weaponId ?? 'longsword',
      backgroundId: opts.backgroundId ?? 'gravedigger',
      assignment: opts.assignment ?? { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
    });
    enterGame(data);
    return window.render_game_to_text();
  };

  window.__statPool = () => state.statPool.map((p) => p.total);
  window.__showHub = () => renderHub();

  boot().catch((err) => {
    document.body.innerHTML = `<p style="padding:2rem;color:#cf5a4a;font-family:monospace">${err.message}</p>`;
  });
})();
