// Page wiring for the analysis board: connects Game (rules/state), BoardView
// (chessground) and the side panel controls.

import { Game, START_FEN } from './game.js';
import { BoardView } from './board.js';
import { renderMoveList } from './movelist.js';

const $ = (id) => document.getElementById(id);

const game = new Game();
const board = new BoardView($('board'), $('promo'), onBoardMove);

const ui = {
  status: $('status'),
  moves: $('moves'),
  fen: $('fen'),
  fenMsg: $('fen-msg'),
  nav: {
    start: $('nav-start'),
    back: $('nav-back'),
    forward: $('nav-forward'),
    end: $('nav-end'),
  },
};

function render() {
  board.show(game);
  const status = game.status();
  ui.status.textContent = status.text;
  ui.status.classList.toggle('over', status.over);
  renderMoveList(ui.moves, game, (ply) => {
    game.goTo(ply);
    render();
  });
  if (document.activeElement !== ui.fen) ui.fen.value = game.fen();
  const atStart = game.ply === 0;
  const atEnd = game.ply === game.moves.length;
  ui.nav.start.disabled = atStart;
  ui.nav.back.disabled = atStart;
  ui.nav.forward.disabled = atEnd;
  ui.nav.end.disabled = atEnd;
}

async function onBoardMove(from, to) {
  let promotion;
  if (game.isPromotion(from, to)) {
    promotion = await board.choosePromotion(game.turn());
    if (!promotion) return render(); // cancelled: put the pawn back
  }
  game.play(from, to, promotion);
  render();
}

function step(action) {
  action();
  render();
}

// ---- navigation ---------------------------------------------------------

ui.nav.start.addEventListener('click', () => step(() => game.toStart()));
ui.nav.back.addEventListener('click', () => step(() => game.back()));
ui.nav.forward.addEventListener('click', () => step(() => game.forward()));
ui.nav.end.addEventListener('click', () => step(() => game.toEnd()));

// Same keys as the desktop app: Left/Right step, Up = end, Down = start.
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || !$('promo').hidden) return;
  const actions = {
    ArrowLeft: () => game.back(),
    ArrowRight: () => game.forward(),
    ArrowUp: () => game.toEnd(),
    ArrowDown: () => game.toStart(),
    Home: () => game.toStart(),
    End: () => game.toEnd(),
    f: () => board.flip(),
  };
  const action = actions[e.key];
  if (action && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    step(action);
  }
});

// Mouse wheel over the board steps through moves (as in the desktop app).
let lastWheel = 0;
$('board').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 60) return;
    lastWheel = now;
    step(() => (e.deltaY > 0 ? game.forward() : game.back()));
  },
  { passive: false },
);

// ---- board tools --------------------------------------------------------

$('btn-flip').addEventListener('click', () => board.flip());
$('btn-new').addEventListener('click', () => {
  game.load(START_FEN);
  setFenMessage('');
  render();
});

// ---- FEN ----------------------------------------------------------------

function setFenMessage(text, kind = '') {
  ui.fenMsg.textContent = text;
  ui.fenMsg.className = `fen-msg ${kind}`;
}

function loadFen() {
  try {
    game.load(ui.fen.value);
    setFenMessage('Position loaded.', 'ok');
    ui.fen.blur();
    render();
  } catch (err) {
    setFenMessage(err.message, 'error');
  }
}

$('btn-fen-load').addEventListener('click', loadFen);
ui.fen.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFen();
  if (e.key === 'Escape') {
    ui.fen.value = game.fen();
    ui.fen.blur();
    setFenMessage('');
  }
});

$('btn-fen-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(game.fen());
    setFenMessage('FEN copied.', 'ok');
  } catch {
    ui.fen.select(); // clipboard API blocked (e.g. plain http): leave it selected to copy by hand
    setFenMessage('Copy blocked by the browser; the FEN is selected.', 'error');
  }
});

render();

// Expose for debugging in the browser console.
window.mpct = { game, board };
