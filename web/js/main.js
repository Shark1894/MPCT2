// Page wiring: connects Game (rules/state), BoardView (chessground), the side
// panels and the repertoire panel.

import { Game, START_FEN } from './game.js';
import { BoardView } from './board.js';
import { renderMoveList } from './movelist.js';
import { RepertoirePanel } from './repertoire.js';
import { TrainingController } from './training.js';
import { isModalOpen, store } from './ui.js';

const $ = (id) => document.getElementById(id);

const game = new Game();
restoreGame();
const board = new BoardView($('board'), $('promo'), onBoardMove);

const repertoire = new RepertoirePanel({
  game,
  onPlaySan: (san) => {
    if (game.playSan(san)) render();
  },
  onShapes: (shapes) => board.setShapes(shapes),
  onOrientation: (color) => board.setOrientation(color),
  onTrain: (opening, mode) => trainer.start(opening, mode),
});

const trainer = new TrainingController({
  game,
  board,
  panel: repertoire,
  render: () => render(),
  onModeChange: (active) => {
    document.body.classList.toggle('training', active);
    document.querySelector('.mode').textContent = active ? 'Training' : 'Repertoire';
    repertoire.setTraining(active);
  },
});

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

let shownFen = null;

function render() {
  board.show(game, { canMove: !trainer.active || trainer.canMove() });
  const status = game.status();
  ui.status.textContent = status.text;
  ui.status.classList.toggle('over', status.over);
  renderMoveList(ui.moves, game, (ply) => {
    if (trainer.active) return; // no peeking ahead while training
    game.goTo(ply);
    render();
  });
  if (document.activeElement !== ui.fen) ui.fen.value = game.fen();
  const atStart = game.ply === 0 || trainer.active;
  const atEnd = game.ply === game.moves.length || trainer.active;
  ui.nav.start.disabled = atStart;
  ui.nav.back.disabled = atStart;
  ui.nav.forward.disabled = atEnd;
  ui.nav.end.disabled = atEnd;

  saveGame();
  if (game.fen() !== shownFen) {
    shownFen = game.fen();
    repertoire.positionChanged();
  }
}

// ---- keep the current game across reloads (phones drop background tabs) ----

function saveGame() {
  store.set('game', { startFen: game.startFen, moves: game.moves.map((m) => m.uci), ply: game.ply });
}

function restoreGame() {
  const saved = store.get('game');
  if (!saved) return;
  try {
    game.load(saved.startFen);
    for (const uci of saved.moves) {
      if (!game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4])) break;
    }
    game.goTo(saved.ply);
  } catch {
    game.load(START_FEN);
  }
}

async function onBoardMove(from, to) {
  let promotion;
  if (game.isPromotion(from, to)) {
    promotion = await board.choosePromotion(game.turn());
    if (!promotion) return render(); // cancelled: put the pawn back
  }
  if (trainer.active) {
    trainer.onUserMove(from, to, promotion);
    return;
  }
  game.play(from, to, promotion);
  render();
}

function step(action) {
  if (trainer.active) return; // navigation is locked while training
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
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || !$('promo').hidden || isModalOpen()) return;
  const actions = {
    ArrowLeft: () => game.back(),
    ArrowRight: () => game.forward(),
    ArrowUp: () => game.toEnd(),
    ArrowDown: () => game.toStart(),
    Home: () => game.toStart(),
    End: () => game.toEnd(),
    f: () => board.flip(),
  };
  const action = trainer.active && e.key !== 'f' ? null : actions[e.key];
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
    if (trainer.active) return;
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
    ui.fen.select(); // clipboard API blocked: leave it selected to copy by hand
    setFenMessage('Copy blocked by the browser; the FEN is selected.', 'error');
  }
});

render();
repertoire.init();

// Expose for debugging in the browser console.
window.mpct = { game, board, repertoire, trainer };
