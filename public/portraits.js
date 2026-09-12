/* Character models.
 *
 * Every figure is drawn procedurally in SVG — there are no image assets and no
 * external requests anywhere in this project. The look is woodcut-by-lamplight:
 * heavy silhouettes, a single warm light source, faces mostly in shadow.
 *
 * window.Portrait.render(classId, backgroundId, opts) -> SVG string
 */

(() => {
  'use strict';

  const uid = (() => { let n = 0; return () => `p${++n}`; })();

  // ------------------------------------------------------------- shared bits

  function defs(id, tint) {
    return `
      <defs>
        <radialGradient id="${id}-lamp" cx="50%" cy="34%" r="62%">
          <stop offset="0%" stop-color="${tint}" stop-opacity="0.30"/>
          <stop offset="55%" stop-color="${tint}" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="${tint}" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="${id}-cloth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4a4038"/>
          <stop offset="100%" stop-color="#221d19"/>
        </linearGradient>
        <linearGradient id="${id}-steel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#9aa0a6"/>
          <stop offset="45%" stop-color="#5d6268"/>
          <stop offset="100%" stop-color="#33373b"/>
        </linearGradient>
        <linearGradient id="${id}-skin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c99b73"/>
          <stop offset="100%" stop-color="#7d5b3f"/>
        </linearGradient>
        <linearGradient id="${id}-model" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="${tint}" stop-opacity="0.16"/>
          <stop offset="28%"  stop-color="#000000" stop-opacity="0"/>
          <stop offset="62%"  stop-color="#000000" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0.46"/>
        </linearGradient>
        <linearGradient id="${id}-floorfade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
          <stop offset="72%"  stop-color="#000000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#0a0806" stop-opacity="0.8"/>
        </linearGradient>
        <filter id="${id}-glow" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="4" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>`;
  }

  /** The pool of light the figure stands in, plus a floor shadow. */
  function stage(id, tint) {
    return `
      <rect x="0" y="0" width="200" height="300" fill="url(#${id}-lamp)"/>
      <ellipse class="pt-shadow" cx="100" cy="286" rx="46" ry="8" fill="#000" opacity="0.45"/>`;
  }

  const head = (id, y = 62) => `
    <ellipse cx="100" cy="${y}" rx="16" ry="18" fill="url(#${id}-skin)"/>
    <!-- the light is above and slightly left, so the jaw and the right cheek go -->
    <ellipse cx="100" cy="${y + 6}" rx="16" ry="13" fill="#000" opacity="0.42"/>
    <ellipse cx="107" cy="${y + 1}" rx="9" ry="15" fill="#000" opacity="0.22"/>
    <!-- brow ridge: one shape, and the face stops being a balloon -->
    <path d="M88 ${y - 5} Q100 ${y - 10} 112 ${y - 5} L112 ${y - 1} Q100 ${y - 5} 88 ${y - 1} Z" fill="#000" opacity="0.45"/>`;

  /**
   * Eyes in shadow. Two flat dots read as an emoji, so each eye is a dark socket
   * with a small warm catchlight sitting low in it, which is where a lamp below
   * the face would actually put it.
   */
  const eyes = (cx, cy, tint = '#e0a13c', r = 1.7) => `
    <ellipse cx="${cx - 5.5}" cy="${cy}" rx="3.4" ry="2.6" fill="#000" opacity="0.75"/>
    <ellipse cx="${cx + 5.5}" cy="${cy}" rx="3.4" ry="2.6" fill="#000" opacity="0.75"/>
    <circle class="pt-flicker" cx="${cx - 5}" cy="${cy + 0.8}" r="${r}" fill="${tint}"/>
    <circle class="pt-flicker" cx="${cx + 6}" cy="${cy + 0.8}" r="${r}" fill="${tint}"/>`;

  const legs = (id) => `
    <path d="M86 200 L82 282 L96 282 L98 200 Z" fill="url(#${id}-cloth)"/>
    <path d="M114 200 L118 282 L104 282 L102 200 Z" fill="url(#${id}-cloth)"/>
    <rect x="78" y="276" width="22" height="9" rx="3" fill="#2b241d"/>
    <rect x="100" y="276" width="22" height="9" rx="3" fill="#241e18"/>`;

  // --------------------------------------------------------------- the classes

  const FIGURES = {
    /** Broad, armoured, sword point-down, shield up. Reads as a doorway. */
    armoured(id) {
      return `
        ${legs(id)}
        <!-- chain skirt -->
        <path d="M74 150 L126 150 L132 206 L68 206 Z" fill="url(#${id}-steel)" opacity="0.75"/>
        <g opacity="0.5" stroke="#1b1f22" stroke-width="1">
          ${Array.from({ length: 6 }, (_, r) => `<line x1="70" y1="${158 + r * 8}" x2="130" y2="${158 + r * 8}"/>`).join('')}
        </g>
        <!-- arms, behind the torso so the pauldrons cap them -->
        <path d="M74 106 Q58 128 58 146" stroke="#4d5359" stroke-width="13" fill="none" stroke-linecap="round"/>
        <path d="M126 106 Q142 128 146 150" stroke="#4d5359" stroke-width="13" fill="none" stroke-linecap="round"/>
        <!-- torso -->
        <path d="M72 96 Q100 86 128 96 L134 156 L66 156 Z" fill="url(#${id}-steel)"/>
        <g opacity="0.45" stroke="#12161a" stroke-width="1.2">
          ${Array.from({ length: 7 }, (_, r) => `<line x1="68" y1="${102 + r * 8}" x2="132" y2="${102 + r * 8}"/>`).join('')}
        </g>
        <!-- pauldrons -->
        <ellipse cx="70" cy="100" rx="17" ry="13" fill="url(#${id}-steel)"/>
        <ellipse cx="130" cy="100" rx="17" ry="13" fill="url(#${id}-steel)"/>
        <!-- gauntlets -->
        <circle cx="58" cy="148" r="8" fill="#5d6268"/>
        <circle cx="147" cy="152" r="8" fill="#5d6268"/>
        ${head(id, 62)}
        <!-- helm with a visor slit -->
        <path d="M82 64 Q100 36 118 64 L118 76 Q100 82 82 76 Z" fill="url(#${id}-steel)"/>
        <rect x="86" y="60" width="28" height="5" rx="2" fill="#0d0f11"/>
        <rect x="97" y="52" width="6" height="30" rx="2" fill="#6b7178"/>
        <!-- sword, point down, gripped at the hip -->
        <g class="pt-sway">
          <rect x="143" y="158" width="8" height="88" rx="2" fill="url(#${id}-steel)"/>
          <path d="M143 246 L151 246 L147 262 Z" fill="#8d939a"/>
          <rect x="131" y="150" width="32" height="7" rx="3" fill="#6b5334"/>
          <rect x="143" y="130" width="8" height="21" rx="3" fill="#3b2f22"/>
          <circle cx="147" cy="128" r="5.5" fill="#7a6134"/>
        </g>
        <!-- shield, left -->
        <path d="M30 108 Q52 99 74 108 L74 162 Q52 194 30 162 Z" fill="#5a4326"/>
        <path d="M30 108 Q52 99 74 108 L74 162 Q52 194 30 162 Z" fill="none" stroke="#2a1f12" stroke-width="3"/>
        <circle cx="52" cy="137" r="9" fill="url(#${id}-steel)"/>
        <line x1="52" y1="104" x2="52" y2="180" stroke="#2a1f12" stroke-width="2" opacity="0.7"/>`;
    },

    /** Hooded, leaner, bow held ready. Face never quite visible. */
    hooded(id) {
      return `
        ${legs(id)}
        <!-- cloak -->
        <path d="M62 96 Q100 84 138 96 L156 250 Q100 268 44 250 Z" fill="url(#${id}-cloth)"/>
        <path d="M100 92 L100 258" stroke="#15120f" stroke-width="2" opacity="0.6"/>
        <!-- arms: one out to the bow, one drawn back to the cheek -->
        <path d="M80 106 Q64 128 56 148" stroke="#453a2f" stroke-width="11" fill="none" stroke-linecap="round"/>
        <path d="M120 106 Q134 118 122 132" stroke="#453a2f" stroke-width="11" fill="none" stroke-linecap="round"/>
        <!-- torso -->
        <path d="M78 98 Q100 90 122 98 L126 158 L74 158 Z" fill="#3a3128"/>
        <path d="M74 158 L126 158 L126 168 L74 168 Z" fill="#2a231c"/>
        <rect x="72" y="150" width="56" height="7" rx="3" fill="#57402a"/>
        <circle cx="55" cy="150" r="6.5" fill="#5c4a34"/>
        <circle cx="121" cy="134" r="6.5" fill="#5c4a34"/>
        ${head(id, 60)}
        <!-- hood: face in shadow, two glints -->
        <path d="M78 66 Q100 26 122 66 Q122 84 100 88 Q78 84 78 66 Z" fill="#302921"/>
        <ellipse cx="100" cy="66" rx="13" ry="14" fill="#0d0b09"/>
        ${eyes(100, 65, '#e0a13c')}
        <!-- quiver -->
        <rect x="128" y="104" width="15" height="46" rx="5" fill="#4a3826" transform="rotate(14 135 127)"/>
        ${[0, 1, 2].map((i) => `<line x1="${132 + i * 4}" y1="106" x2="${129 + i * 4}" y2="90" stroke="#c9b48a" stroke-width="2" transform="rotate(14 135 127)"/>`).join('')}
        <!-- bow, drawn: the string pulls back to the far hand -->
        <g class="pt-sway">
          <path d="M50 88 Q24 150 50 212" fill="none" stroke="#6b4f2c" stroke-width="6" stroke-linecap="round"/>
          <path d="M50 88 L120 134 L50 212" fill="none" stroke="#d8cdb4" stroke-width="1.4" opacity="0.85"/>
          <line x1="30" y1="150" x2="124" y2="146" stroke="#c9b48a" stroke-width="2"/>
          <path d="M124 142 L134 146 L124 150 Z" fill="#c9b48a"/>
        </g>`;
    },

    /**
     * Grave-wrappings, a bell held low, and something standing behind them that
     * is not quite drawn. The Necromancer is the only figure with a second
     * silhouette in the frame — the Thrall is the class, so it is in the portrait.
     */
    shrouded(id) {
      const motes = Array.from({ length: 6 }, (_, i) => {
        const x = 46 + ((i * 41) % 118);
        const y = 96 + ((i * 47) % 140);
        return `<circle class="pt-ember pt-ember-${i % 4}" cx="${x}" cy="${y}" r="${1.2 + (i % 3) * 0.5}" fill="#8fb79a"/>`;
      }).join('');

      return `
        <!-- the thing behind: unlit, unfinished, patient -->
        <path d="M126 108 Q150 96 168 116 L176 276 Q150 284 122 276 Z" fill="#1a1f1c" opacity="0.85"/>
        <ellipse cx="149" cy="96" rx="15" ry="16" fill="#161a18"/>
        <circle cx="144" cy="95" r="1.8" fill="#8fb79a" class="pt-flicker"/>
        <circle cx="155" cy="95" r="1.8" fill="#8fb79a" class="pt-flicker"/>

        <!-- wrappings: no legs, they trail -->
        <path d="M70 102 Q100 90 130 102 L150 278 Q100 292 50 278 Z" fill="url(#${id}-cloth)"/>
        <g opacity="0.4" stroke="#0f120f" stroke-width="1.5" fill="none">
          ${Array.from({ length: 9 }, (_, r) => `<path d="M${54 + r} ${118 + r * 18} Q100 ${110 + r * 18} ${146 - r} ${118 + r * 18}"/>`).join('')}
        </g>
        <!-- one arm down, holding the bell by its crown -->
        <path d="M76 112 Q62 150 70 186" stroke="#4a4038" stroke-width="11" fill="none" stroke-linecap="round"/>
        <path d="M126 110 Q140 130 132 150" stroke="#4a4038" stroke-width="11" fill="none" stroke-linecap="round"/>
        <path d="M70 102 Q100 90 130 102 L134 152 Q100 164 66 152 Z" fill="#2f3630"/>

        <!-- the grave-bell -->
        <line x1="70" y1="186" x2="70" y2="198" stroke="#6b6257" stroke-width="2.5"/>
        <path d="M58 216 Q58 198 70 198 Q82 198 82 216 Z" fill="#8a7f6d"/>
        <ellipse cx="70" cy="217" rx="12" ry="3.5" fill="#6b6257"/>
        <circle cx="70" cy="223" r="3" fill="#8fb79a" class="pt-flicker"/>

        <!-- No head ellipse: nothing of this one is uncovered, so the cowl IS
             the head. Drawing skin underneath only let the skull poke out above
             the hood's curve. -->
        <path d="M72 74 Q100 22 128 74 Q128 96 100 100 Q72 96 72 74 Z" fill="#2b322c"/>
        <path d="M72 74 Q100 22 128 74" fill="none" stroke="#1a1f1b" stroke-width="2.5"/>
        <ellipse cx="100" cy="74" rx="15" ry="16" fill="#0b0d0b"/>
        ${eyes(100, 73, '#8fb79a', 1.9)}
        ${motes}
      `;
    },

    /** Robed, hooded, rod alight. The flame is the whole silhouette's point. */
    robed(id) {
      const embers = Array.from({ length: 7 }, (_, i) => {
        const x = 40 + ((i * 37) % 130);
        const y = 90 + ((i * 53) % 150);
        return `<circle class="pt-ember pt-ember-${i % 4}" cx="${x}" cy="${y}" r="${1.4 + (i % 3) * 0.6}" fill="#e0913c"/>`;
      }).join('');

      return `
        <!-- robe: no legs, it pools on the floor -->
        <path d="M70 100 Q100 88 130 100 L152 278 Q100 292 48 278 Z" fill="url(#${id}-cloth)"/>
        <path d="M100 96 L100 282" stroke="#141110" stroke-width="2" opacity="0.55"/>
        <!-- arms: one raised to the rod, one folded across -->
        <path d="M126 108 Q144 122 150 138" stroke="#3f352c" stroke-width="11" fill="none" stroke-linecap="round"/>
        <path d="M74 108 Q66 132 88 142" stroke="#3f352c" stroke-width="11" fill="none" stroke-linecap="round"/>
        <path d="M70 100 Q100 88 130 100 L134 150 Q100 162 66 150 Z" fill="#453a2f"/>
        <rect x="70" y="146" width="60" height="8" rx="3" fill="#6b4f2c"/>
        <circle cx="151" cy="140" r="7" fill="#7d5b3f"/>
        <circle cx="90" cy="143" r="6.5" fill="#7d5b3f"/>
        ${head(id, 62)}
        <path d="M76 68 Q100 26 124 68 Q124 88 100 92 Q76 88 76 68 Z" fill="#3a2f26"/>
        <ellipse cx="100" cy="68" rx="14" ry="15" fill="#0d0b09"/>
        ${eyes(100, 67, '#e0913c')}
        <!-- rod -->
        <rect x="148" y="72" width="7" height="176" rx="3" fill="#2e2419"/>
        <rect x="148" y="72" width="7" height="176" rx="3" fill="none" stroke="#100d0a" stroke-width="1"/>
        <!-- flame -->
        <g filter="url(#${id}-glow)" class="pt-flame">
          <path d="M151.5 30 Q166 52 151.5 72 Q137 52 151.5 30 Z" fill="#e0913c"/>
          <path d="M151.5 42 Q160 55 151.5 68 Q143 55 151.5 42 Z" fill="#f6d99a"/>
        </g>
        ${embers}`;
    },

    /** Scale armour, mace, and a lantern that actually lights the scene. */
    lantern(id) {
      return `
        ${legs(id)}
        <path d="M74 152 L126 152 L130 204 L70 204 Z" fill="#3f362c"/>
        <!-- scale torso -->
        <path d="M74 96 Q100 86 126 96 L132 156 L68 156 Z" fill="#4d4438"/>
        <g opacity="0.55" fill="none" stroke="#241e18" stroke-width="1.1">
          ${Array.from({ length: 6 }, (_, r) =>
            Array.from({ length: 7 }, (_, c) =>
              `<path d="M${70 + c * 9} ${102 + r * 9} a4.5 4.5 0 0 0 9 0"/>`
            ).join('')
          ).join('')}
        </g>
        <ellipse cx="72" cy="100" rx="14" ry="11" fill="#5a5044"/>
        <ellipse cx="128" cy="100" rx="14" ry="11" fill="#5a5044"/>
        <!-- arms: lantern out to the left, mace down on the right -->
        <path d="M74 108 Q60 118 54 130" stroke="#4d4438" stroke-width="12" fill="none" stroke-linecap="round"/>
        <path d="M126 108 Q142 130 148 152" stroke="#4d4438" stroke-width="12" fill="none" stroke-linecap="round"/>
        <circle cx="53" cy="132" r="7" fill="#7d5b3f"/>
        <circle cx="149" cy="154" r="7" fill="#7d5b3f"/>
        ${head(id, 60)}
        <path d="M84 56 Q100 40 116 56 L116 66 Q100 60 84 66 Z" fill="#5a5044"/>
        <!-- sigil on the chest -->
        <circle cx="100" cy="122" r="9" fill="none" stroke="#e0a13c" stroke-width="2" opacity="0.85"/>
        <line x1="100" y1="115" x2="100" y2="129" stroke="#e0a13c" stroke-width="2" opacity="0.85"/>
        <!-- mace, right -->
        <rect x="146" y="140" width="6" height="80" rx="2" fill="#3b2f22"/>
        <circle cx="149" cy="134" r="11" fill="url(#${id}-steel)"/>
        ${[0, 1, 2, 3].map((i) => `<rect x="146" y="120" width="6" height="7" rx="2" fill="#7d838a" transform="rotate(${i * 90} 149 134)"/>`).join('')}
        <!-- lantern on a chain, left -->
        <g class="pt-lantern">
          <line x1="52" y1="102" x2="52" y2="140" stroke="#6f675e" stroke-width="2"/>
          <path d="M40 140 L64 140 L60 176 L44 176 Z" fill="#4a4038" stroke="#241e18" stroke-width="2"/>
          <rect x="44" y="146" width="16" height="24" fill="#f6d99a" class="pt-flicker"/>
          <rect x="38" y="136" width="28" height="6" rx="2" fill="#5a5044"/>
          <circle cx="52" cy="158" r="26" fill="#e0a13c" opacity="0.16" filter="url(#${id}-glow)"/>
        </g>`;
    },
  };

  // --------------------------------------------------- background accessories

  const ACCENTS = {
    gravedigger: () => `
      <ellipse cx="26" cy="280" rx="15" ry="4" fill="#000" opacity="0.5"/>
      <g transform="translate(18 150) rotate(-9)">
        <rect x="0" y="0" width="5" height="128" rx="2" fill="#3a2c1d"/>
        <path d="M-6 126 L11 126 L8 148 L-3 148 Z" fill="#4d5257"/>
        <path d="M-6 126 L11 126" stroke="#6b7178" stroke-width="1.5"/>
      </g>`,
    caravan_guard: () => `
      <g transform="translate(126 158)">
        <path d="M0 0 Q22 4 30 20 Q14 20 0 12 Z" fill="#c9b48a"/>
        <path d="M0 0 Q22 4 30 20" fill="none" stroke="#8a7a58" stroke-width="1.5"/>
      </g>`,
    scholar: () => `
      <g transform="translate(124 156)">
        <rect x="0" y="0" width="24" height="30" rx="2" fill="#5c4a34"/>
        <rect x="3" y="3" width="21" height="24" rx="1" fill="#c9b48a"/>
        <line x1="0" y1="15" x2="24" y2="15" stroke="#3a2f22" stroke-width="2"/>
      </g>`,
    gutter_rat: () => `
      <g transform="translate(60 158)">
        ${[0, 1, 2].map((i) => `<path d="M${i * 6} 0 L${i * 6 + 1} 22 L${i * 6 + 4} 26" fill="none" stroke="#9aa0a6" stroke-width="2"/>`).join('')}
      </g>`,
    ferryman: () => `
      <ellipse cx="28" cy="280" rx="14" ry="4" fill="#000" opacity="0.5"/>
      <g transform="translate(22 120) rotate(-7)">
        <rect x="0" y="0" width="4" height="150" rx="2" fill="#4a3620"/>
        <path d="M-4 146 L8 146 L6 162 L-2 162 Z" fill="#33281a"/>
      </g>`,
    debt_collector: () => `
      <g transform="translate(126 154)">
        <rect x="0" y="0" width="22" height="28" rx="2" fill="#3b3b42"/>
        <rect x="0" y="0" width="22" height="28" rx="2" fill="none" stroke="#8d939a" stroke-width="2"/>
        <line x1="0" y1="9"  x2="22" y2="9"  stroke="#8d939a" stroke-width="1.5"/>
        <line x1="0" y1="19" x2="22" y2="19" stroke="#8d939a" stroke-width="1.5"/>
      </g>`,
    mine_child: () => `
      <g transform="translate(28 150)">
        <rect x="0" y="0" width="16" height="20" rx="3" fill="#4a4038" stroke="#241e18" stroke-width="2"/>
        <rect x="3" y="4" width="10" height="12" fill="#f6d99a" class="pt-flicker"/>
        <circle cx="8" cy="10" r="18" fill="#e0a13c" opacity="0.13"/>
      </g>`,
    apostate: () => `
      <g transform="translate(128 160) rotate(18)">
        <circle cx="10" cy="10" r="9" fill="none" stroke="#6f675e" stroke-width="2.5"/>
        <line x1="10" y1="1" x2="10" y2="19" stroke="#6f675e" stroke-width="2.5"/>
        <line x1="1" y1="19" x2="19" y2="1" stroke="#cf5a4a" stroke-width="2"/>
      </g>`,
    fenwitch: () => `
      <g transform="translate(30 152)">
        ${[0, 1, 2, 3].map((i) => `<path d="M${i * 5} 30 Q${i * 5 + 2} 12 ${i * 5 - 1} 0" fill="none" stroke="#7fa650" stroke-width="2"/>`).join('')}
        <rect x="-2" y="16" width="22" height="4" rx="2" fill="#57402a"/>
      </g>`,
    deserter: () => `
      <g transform="translate(126 152)">
        <path d="M0 0 L20 4 L18 16 L0 12 Z" fill="#6b4f2c"/>
        <path d="M0 12 L18 16 L14 22 L0 18 Z" fill="#4a3826"/>
        <line x1="0" y1="-2" x2="0" y2="34" stroke="#3b2f22" stroke-width="2.5"/>
      </g>`,
  };

  // -------------------------------------------------------------------- api

  const TINTS = {
    armoured: '#e0a13c',
    hooded: '#7fa650',
    robed: '#e0743c',
    lantern: '#e8d08a',
    shrouded: '#8fb79a',
  };

  function render(figureId, backgroundId, opts = {}) {
    const id = uid();
    const figure = FIGURES[figureId] ?? FIGURES.armoured;
    const tint = TINTS[figureId] ?? '#e0a13c';
    const accent = ACCENTS[backgroundId];

    return `<svg class="portrait portrait-${figureId}" viewBox="0 0 200 300"
                 xmlns="http://www.w3.org/2000/svg" role="img"
                 aria-label="${opts.label ?? figureId}" preserveAspectRatio="xMidYMid meet">
      ${defs(id, tint)}
      ${stage(id, tint)}
      <g class="pt-breathe">
        ${accent ? accent() : ''}
        ${figure(id)}
        <!-- one light source, laid over everything: warm rim on the left, the
             right side falling into the dark. This is what stops the figures
             reading as flat cut-outs. -->
        <rect x="0" y="0" width="200" height="300" fill="url(#${id}-model)" pointer-events="none"/>
        <!-- and the feet sink into the floor instead of stopping at a hard edge -->
        <rect x="0" y="0" width="200" height="300" fill="url(#${id}-floorfade)" pointer-events="none"/>
      </g>
    </svg>`;
  }

  window.Portrait = { render, TINTS };
})();
