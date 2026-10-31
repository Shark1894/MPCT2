// Board view: wraps chessground (drawing + input) and the promotion picker.
// It knows nothing about chess rules; it shows whatever Game state it is given
// and reports the squares the user moved between.

import { Chessground } from '../vendor/chessground/chessground.min.js';

const PROMOTION_PIECES = [
  ['q', 'queen'],
  ['r', 'rook'],
  ['b', 'bishop'],
  ['n', 'knight'],
];

export class BoardView {
  /**
   * @param {HTMLElement} el            element chessground draws into
   * @param {HTMLElement} promoEl       overlay element for the promotion picker
   * @param {(from: string, to: string) => void} onMove  called after the user drops a piece
   */
  constructor(el, promoEl, onMove) {
    this.promoEl = promoEl;
    this.cg = Chessground(el, {
      orientation: 'white',
      coordinates: true,
      animation: { enabled: true, duration: 150 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        showDests: true,
        events: { after: (from, to) => onMove(from, to) },
      },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      drawable: { enabled: true }, // right-click arrows and circles
    });
  }

  /** Redraw from game state. */
  show(game) {
    const turn = game.turn();
    this.cg.set({
      fen: game.fen(),
      turnColor: turn,
      lastMove: game.lastMove(),
      check: game.inCheck() ? turn : false,
      movable: {
        color: game.isOver() ? undefined : turn,
        dests: game.isOver() ? new Map() : game.dests(),
      },
    });
  }

  orientation() {
    return this.cg.state.orientation;
  }

  flip() {
    this.cg.toggleOrientation();
  }

  /**
   * Ask which piece to promote to. Resolves 'q' | 'r' | 'b' | 'n', or null if cancelled
   * (Escape, or a click outside the choices).
   */
  choosePromotion(color) {
    const el = this.promoEl;
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'promo-box';
    el.appendChild(box);

    return new Promise((resolve) => {
      const done = (choice) => {
        el.hidden = true;
        el.innerHTML = '';
        document.removeEventListener('keydown', onKey, true);
        resolve(choice);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(null);
        }
      };
      for (const [letter, name] of PROMOTION_PIECES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'promo-choice cg-wrap';
        btn.setAttribute('aria-label', `Promote to ${name}`);
        btn.innerHTML = `<piece class="${name} ${color}"></piece>`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          done(letter);
        });
        box.appendChild(btn);
      }
      el.onclick = () => done(null);
      document.addEventListener('keydown', onKey, true);
      el.hidden = false;
      box.querySelector('button').focus();
    });
  }
}
