// Page wiring: connects Game (rules/state), BoardView (chessground), the side
// panels and the repertoire panel.

import { Game, START_FEN } from './game.js';
import { BoardView } from './board.js';
import { renderMoveList } from './movelist.js';
import { RepertoirePanel } from './repertoire.js';
import { TrainingController } from './training.js';
import { DashboardView } from './dashboard.js';
import { AnalysisPanel } from './analysis.js';
import { GamePanel, GamesView } from './games.js';
import { PlayController } from './play.js';
import { ReviewController } from './review.js';
import { SavedEval } from './saved-eval.js';
import { isModalOpen, store } from './ui.js';

const $ = (id) => document.getElementById(id);

const game = new Game();
restoreGame();
const board = new BoardView($('board'), $('promo'), onBoardMove);

const analysis = new AnalysisPanel({
  game,
  board,
  onPlayMoves: (ucis) => {
    for (const uci of ucis) if (!game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4])) break;
    render();
  },
});

const repertoire = new RepertoirePanel({
  game,
  onPlaySan: (san) => {
    if (play.active && !play.canMove()) return;
    if (game.playSan(san)) render();
  },
  onShapes: (shapes) => board.setShapes(shapes),
  onOrientation: (color) => board.setOrientation(color),
  onTrain: (opening, mode, tag) => startTraining(opening, mode, null, tag),
  onJump: (ply) => {
    if (trainer.active) return;
    game.goTo(ply);
    render();
  },
  onShowTag: (tag) => showTagPosition(tag),
});

/**
 * Move the board to a branch tag's position. If the moves on the board already pass through
 * it, just jump there (keeping the moves after it); otherwise set up the tag's moves from the start.
 */
async function showTagPosition(tag) {
  if (trainer.active) return;
  const key = (fen) => fen.split(' ').slice(0, 4).join(' ');
  if (key(game.startFen) === key(START_FEN)) {
    const ply = game.moves.findIndex((m) => key(m.fen) === tag.key) + 1;
    if (ply > 0) {
      game.goTo(ply);
      render();
      return;
    }
  }
  if (!(await play.confirmStop())) return;
  if (!(await gamePanel.confirmLeave())) return;
  game.load(START_FEN);
  for (const san of tag.path) if (!game.playSan(san)) break;
  render();
}
// Branch tags or the branch filter changed: keep the dashboard in step when it's showing.
repertoire.onTagsChanged = () => {
  if (view === 'dashboard') dashboard.refresh();
};

const dashboard = new DashboardView({
  repertoire,
  onTrain: (opening, mode, lineId, tag, label) => {
    setView('board');
    startTraining(opening, mode, lineId, tag, label);
  },
  onShowLine: async (sans) => {
    if (!(await play.confirmStop())) return;
    game.load(START_FEN);
    for (const san of sans) if (!game.playSan(san)) break;
    setView('board');
    render();
  },
});

const trainer = new TrainingController({
  game,
  board,
  panel: repertoire,
  render: () => render(),
  onModeChange: (active) => {
    if (active) analysis.pause('training');
    else analysis.resume('training');
    document.body.classList.toggle('training', active);
    $('mode-badge').hidden = !active;
    $('view-dashboard').disabled = active;
    $('view-games').disabled = active;
    repertoire.setTraining(active);
  },
});

// ---- games -------------------------------------------------------------------

const gamePanel = new GamePanel({
  game,
  getOpening: () => repertoire._opening(),
  render: () => render(),
  onClosed: () => {
    if (view === 'games') gamesView.refresh();
  },
});

const gamesView = new GamesView({
  panel: gamePanel,
  game,
  onOpen: async (id) => {
    if (!(await play.confirmStop())) return;
    if (await gamePanel.open(id)) setView('board');
  },
});

// ---- play vs engine ------------------------------------------------------------

const play = new PlayController({
  game,
  board,
  render: () => render(),
  beforeStart: () => gamePanel.confirmLeave(),
  onModeChange: (active) => {
    if (active) analysis.pause('play');
    else analysis.resume('play');
    document.body.classList.toggle('playing', active);
  },
  onSaved: async (id) => {
    await gamePanel.open(id);
  },
});

// ---- engine review --------------------------------------------------------------

const savedEval = new SavedEval($('saved-eval'));
analysis.onToggle = () => render(); // the saved evaluation line hides while the live engine is on

const review = new ReviewController({
  game,
  board,
  analysis,
  getOpening: () => repertoire._opening(),
  isBusy: () => trainer.active || play.active,
  onJump: (ply) => {
    if (trainer.active || play.active) return;
    game.goTo(ply);
    render();
  },
  onChanged: () => render(),
  onSaved: (fen, ev) => savedEval.remember(fen, ev),
});

/** Training replaces the board's moves, so an open game is closed first (asking if unsaved). */
async function startTraining(opening, mode, lineId, tag, label) {
  if (!(await play.confirmStop())) return;
  if (!(await gamePanel.confirmLeave())) return;
  trainer.start(opening, mode, lineId, tag, label);
}

// ---- views: Board | Dashboard | Games -----------------------------------------------

const VIEWS = { board: 'main.layout', dashboard: '#dashboard', games: '#games-view' };
let view = 'board';

function setView(next) {
  if (next !== 'board' && trainer.active) return;
  view = next;
  for (const [name, sel] of Object.entries(VIEWS)) {
    document.querySelector(sel).hidden = view !== name;
    $(`view-${name}`).setAttribute('aria-pressed', String(view === name));
  }
  store.set('view', view);
  if (view === 'board') {
    board.redraw();
    analysis.resume('away');
  } else {
    analysis.pause('away'); // the board isn't visible
    if (view === 'dashboard') dashboard.refresh();
    if (view === 'games') gamesView.refresh();
  }
  window.scrollTo(0, 0);
}

for (const name of Object.keys(VIEWS)) $(`view-${name}`).addEventListener('click', () => setView(name));

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
  board.show(game, { canMove: trainer.active ? trainer.canMove() : play?.active ? play.canMove() : true });
  const status = game.status();
  ui.status.textContent = status.text;
  ui.status.classList.toggle('over', status.over);
  review?.update();
  // Hidden when something else already shows the evaluation (review panel, live engine) or it would give answers away.
  savedEval?.update(game.fen(), Boolean(review?.open) || analysis.settings.on || trainer.active || Boolean(play?.active));
  renderMoveList(
    ui.moves,
    game,
    (ply) => {
      if (trainer.active) return; // no peeking ahead while training
      game.goTo(ply);
      render();
    },
    review?.annotations(),
  );
  if (document.activeElement !== ui.fen) ui.fen.value = game.fen();
  const atStart = game.ply === 0 || trainer.active;
  const atEnd = game.ply === game.moves.length || trainer.active;
  ui.nav.start.disabled = atStart;
  ui.nav.back.disabled = atStart;
  ui.nav.forward.disabled = atEnd;
  ui.nav.end.disabled = atEnd;

  saveGame();
  gamePanel?.updateState();
  play?.update();
  if (game.fen() !== shownFen) {
    shownFen = game.fen();
    repertoire.positionChanged();
    analysis.positionChanged();
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
  if (play.active && !play.canMove()) return render();
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
  if (view !== 'board' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || !$('promo').hidden || isModalOpen()) return;
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
  if (play.active) return;
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
  if (play.active) return;
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
play.restore();
repertoire.init().then(async () => {
  const openGameId = store.get('openGameId');
  if (openGameId) await gamePanel.open(openGameId);
  const saved = store.get('view');
  if (saved && saved !== 'board' && VIEWS[saved]) setView(saved);
  await review.restore();
  render();
});

// Expose for debugging in the browser console.
window.mpct = { game, board, repertoire, trainer, dashboard, setView, render, analysis, gamePanel, gamesView, play, review, savedEval };
