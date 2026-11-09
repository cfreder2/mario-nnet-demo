// Keyboard + gamepad → NES controller bit masks (bit n = BTN n).
//
// Keyboard (player 1): arrows move, X / Space / K jump (A), Z / J / Shift run
// (B), Enter = Start, Backspace = Select.
// Gamepads: the first pad is player 1, the second player 2. A pad the browser
// recognises ("standard" mapping, e.g. Xbox/PlayStation/8BitDo in X-input)
// uses bottom/right face buttons for A and left/top for B. Unrecognised USB
// NES/SNES pads get a best-guess layout; override it with ?pad=1:A,2:A,0:B,3:B
// (button index : NES button) after checking indices on gamepad-tester.com.

import { BTN } from './smb.js';

const KEYS = {
  ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, ArrowUp: BTN.UP, ArrowDown: BTN.DOWN,
  KeyX: BTN.A, Space: BTN.A, KeyK: BTN.A,
  KeyZ: BTN.B, KeyJ: BTN.B, ShiftLeft: BTN.B, ShiftRight: BTN.B,
  Enter: BTN.START, NumpadEnter: BTN.START, Backspace: BTN.SELECT,
};

const STANDARD = { 0: BTN.A, 1: BTN.A, 2: BTN.B, 3: BTN.B, 8: BTN.SELECT, 9: BTN.START, 12: BTN.UP, 13: BTN.DOWN, 14: BTN.LEFT, 15: BTN.RIGHT };
const GENERIC = { 1: BTN.A, 2: BTN.A, 0: BTN.B, 3: BTN.B, 8: BTN.SELECT, 9: BTN.START, 12: BTN.UP, 13: BTN.DOWN, 14: BTN.LEFT, 15: BTN.RIGHT };

function parsePadParam() {
  const p = new URLSearchParams(location.search).get('pad');
  if (!p) return null;
  const map = {};
  for (const part of p.split(',')) {
    const [i, b] = part.split(':');
    if (BTN[b] !== undefined) map[Number(i)] = BTN[b];
  }
  return map;
}

export class Input {
  constructor() {
    this.down = new Set();
    this.lastActivity = performance.now();
    this.prevP1 = 0;
    this.override = parsePadParam();
    this.padCount = 0;
    this.onKey = null; // optional hook for screen-level hotkeys: (event) => handled?
    addEventListener('keydown', (e) => {
      if (this.onKey && this.onKey(e)) return;
      if (e.code in KEYS) {
        e.preventDefault();
        this.down.add(e.code);
        this.lastActivity = performance.now();
      }
    });
    addEventListener('keyup', (e) => {
      if (e.code in KEYS) { e.preventDefault(); this.down.delete(e.code); }
    });
    addEventListener('blur', () => this.down.clear());
  }

  /** Read everything once per emulated frame. */
  poll() {
    let p1 = 0, p2 = 0;
    for (const code of this.down) p1 |= 1 << KEYS[code];
    const pads = (navigator.getGamepads?.() || []).filter(Boolean);
    this.padCount = pads.length;
    pads.slice(0, 2).forEach((gp, idx) => {
      let m = 0;
      const map = this.override || (gp.mapping === 'standard' ? STANDARD : GENERIC);
      gp.buttons.forEach((b, i) => { if ((b.pressed || b.value > 0.5) && map[i] !== undefined) m |= 1 << map[i]; });
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ax < -0.5) m |= 1 << BTN.LEFT;
      if (ax > 0.5) m |= 1 << BTN.RIGHT;
      if (ay < -0.5) m |= 1 << BTN.UP;
      if (ay > 0.5) m |= 1 << BTN.DOWN;
      // Some USB pads report the d-pad as a hat switch on axis 9: -1 = up,
      // then clockwise in steps of 2/7 to +1 = up-left; ~1.29 = released.
      const hat = gp.axes[9];
      if (gp.mapping !== 'standard' && hat !== undefined && Math.abs(hat) <= 1.01 && Math.abs(hat) > 0.05) {
        const dir = Math.round(((hat + 1) / 2) * 7); // 0 up, 2 right, 4 down, 6 left
        if ([7, 0, 1].includes(dir)) m |= 1 << BTN.UP;
        if ([1, 2, 3].includes(dir)) m |= 1 << BTN.RIGHT;
        if ([3, 4, 5].includes(dir)) m |= 1 << BTN.DOWN;
        if ([5, 6, 7].includes(dir)) m |= 1 << BTN.LEFT;
      }
      if (idx === 0) p1 |= m; else p2 |= m;
    });
    // holding a direction counts as playing: a runner can hold right for a long time
    if (p1 || p2) this.lastActivity = performance.now();
    this.prevP1 = p1;
    return { p1, p2 };
  }

  idleSeconds() {
    return (performance.now() - this.lastActivity) / 1000;
  }
}
