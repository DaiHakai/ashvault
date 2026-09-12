/* Animated dice.
 *
 * IMPORTANT: this is a presentation layer and nothing else. The server has
 * already rolled and already decided the outcome (GAME_DESIGN.md §1.5). These
 * dice tumble through *fake* intermediate faces and then land on the real
 * values they were handed. The client never generates a result it then reports.
 *
 * window.Dice.show(container, rollResult, { onSettle })
 */

(() => {
  'use strict';

  const TUMBLE_MS = 620;
  const STAGGER_MS = 70;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** A d20 is drawn as an icosahedron seen face-on; everything else is a slab. */
  function faceShape(sides) {
    if (sides === 20) {
      return `<polygon points="30,3 55,17 55,43 30,57 5,43 5,17" />
              <polygon class="die-inner" points="30,12 47,21 47,39 30,48 13,39 13,21" />`;
    }
    if (sides === 12) return `<polygon points="30,4 54,22 45,52 15,52 6,22" />`;
    if (sides === 8) return `<polygon points="30,3 55,30 30,57 5,30" />`;
    if (sides === 4) return `<polygon points="30,5 56,52 4,52" />`;
    if (sides === 6) return `<rect x="7" y="7" width="46" height="46" rx="7" />`;
    return `<circle cx="30" cy="30" r="25" />`;
  }

  function dieEl(sides, kind) {
    const el = document.createElement('div');
    el.className = `die die-d${sides} die-${kind}`;
    el.innerHTML = `
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <g class="die-body">${faceShape(sides)}</g>
      </svg>
      <span class="die-value">?</span>`;
    return el;
  }

  function sidesFromNotation(notation) {
    const m = /d(\d+)/i.exec(notation ?? '');
    return m ? Number(m[1]) : 20;
  }

  /**
   * Render one roll's dice into `container` and animate them onto their values.
   * Kept dice land bright; dropped dice (4d6-drop-lowest, the discarded d20 of
   * an advantage roll) land dimmed and struck through, because hiding them
   * would be hiding the maths the player is promised.
   */
  function show(container, roll, opts = {}) {
    if (!container || !roll) return;
    const sides = sidesFromNotation(roll.notation);

    // Work out which raw dice were kept so each die can be styled honestly.
    const keptPool = [...(roll.kept ?? roll.dice ?? [])];
    const faces = (roll.dice ?? []).map((value) => {
      const i = keptPool.indexOf(value);
      if (i !== -1) { keptPool.splice(i, 1); return { value, kept: true }; }
      return { value, kept: false };
    });

    container.innerHTML = '';
    container.classList.add('tray-live');

    const tray = document.createElement('div');
    tray.className = 'die-row';
    container.appendChild(tray);

    const els = faces.map(({ value, kept }) => {
      const el = dieEl(sides, kept ? 'kept' : 'dropped');
      el.dataset.final = String(value);
      tray.appendChild(el);
      return el;
    });

    const summary = document.createElement('div');
    summary.className = 'die-summary';
    container.appendChild(summary);

    const settle = () => {
      summary.innerHTML = summaryHtml(roll);
      summary.classList.add('die-summary-in');
      container.classList.remove('tray-live');
      opts.onSettle?.();
    };

    if (reduceMotion) {
      els.forEach((el) => {
        el.querySelector('.die-value').textContent = el.dataset.final;
        el.classList.add('die-settled');
      });
      settle();
      return;
    }

    let landed = 0;
    els.forEach((el, i) => {
      const valueEl = el.querySelector('.die-value');
      const delay = i * STAGGER_MS;
      const duration = TUMBLE_MS + delay;

      el.style.setProperty('--spin', `${(Math.random() * 300 + 380).toFixed(0)}deg`);
      el.style.setProperty('--tilt', `${(Math.random() * 30 - 15).toFixed(0)}deg`);
      el.classList.add('die-tumbling');

      // Cycle plausible faces while it is in the air, then land on the real one.
      const cycle = setInterval(() => {
        valueEl.textContent = String(1 + Math.floor(Math.random() * sides));
      }, 55);

      setTimeout(() => {
        clearInterval(cycle);
        valueEl.textContent = el.dataset.final;
        el.classList.remove('die-tumbling');
        el.classList.add('die-settled');
        if (Number(el.dataset.final) === sides && sides === 20) el.classList.add('die-crit');
        if (Number(el.dataset.final) === 1 && sides === 20) el.classList.add('die-fumble');
        if (++landed === els.length) settle();
      }, duration);
    });
  }

  function summaryHtml(roll) {
    const mod = roll.modifier === 0 ? '' : roll.modifier > 0 ? ` + ${roll.modifier}` : ` − ${Math.abs(roll.modifier)}`;
    const vs = roll.vs === null || roll.vs === undefined ? '' :
      ` <span class="die-vs">vs ${roll.vsLabel ?? 'DC'} ${roll.vs}</span>`;
    const outcome = roll.outcome
      ? ` <span class="die-outcome die-outcome-${roll.outcome}">${roll.outcome.toUpperCase()}</span>`
      : '';
    const adv = roll.advantage === 'advantage' ? ' <span class="die-adv">advantage</span>'
      : roll.advantage === 'disadvantage' ? ' <span class="die-adv die-dis">disadvantage</span>' : '';
    return `<span class="die-total">${roll.total}</span>
            <span class="die-math">${roll.notation}${mod}</span>${adv}${vs}${outcome}`;
  }

  /** Static, non-animating dice — used for the six creation rolls. */
  function still(container, roll) {
    const sides = sidesFromNotation(roll.notation);
    const keptPool = [...(roll.kept ?? [])];
    container.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'die-row die-row-small';
    for (const value of roll.dice ?? []) {
      const i = keptPool.indexOf(value);
      const kept = i !== -1;
      if (kept) keptPool.splice(i, 1);
      const el = dieEl(sides, kept ? 'kept' : 'dropped');
      el.querySelector('.die-value').textContent = String(value);
      el.classList.add('die-settled');
      row.appendChild(el);
    }
    container.appendChild(row);
  }

  window.Dice = { show, still };
})();
