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
import { WildView } from './wild.js';
import { Sounds, movedOneForward } from './sounds.js';
import { PuzzleController, PuzzlesView } from './puzzles.js';
import { isModalOpen, plural, store, toast } from './ui.js';
import { reviewComplete, reviewPayload } from './gamereview.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);

const game = new Game();
const sounds = new Sounds();
let soundState = null; // { startFen, ply } at the last render, to hear one-move steps
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

/** Training and puzzles share one mode: repertoire hidden, other tabs locked. Training also
 *  hides the engine throughout; puzzles hide it only while unsolved (see onLock). */
function trainingMode(active, badge, bodyClass = 'training') {
  if (bodyClass === 'training') {
    if (active) analysis.pause('training');
    else analysis.resume('training');
  }
  document.body.classList.toggle(bodyClass, active);
  $('mode-badge').textContent = badge;
  $('mode-badge').hidden = !active;
  for (const v of ['dashboard', 'games', 'wild', 'puzzles']) $(`view-${v}`).disabled = active;
  repertoire.setTraining(active);
}

const trainer = new TrainingController({
  game,
  board,
  panel: repertoire,
  render: () => render(),
  onModeChange: (active) => trainingMode(active, 'Training'),
  onContinue: (info) => continueLineVsEngine(info),
});

/** "Play on vs engine" at the end of a training line: the session waits while you play. */
async function continueLineVsEngine({ side, opening, last }) {
  const level = await play.chooseContinueLevel(opening);
  if (!level || !trainer.active) return;
  trainer.suspend();
  play.start(side, level, true, {
    opening,
    returnTo: {
      label: last ? 'Finish training' : 'Next line',
      onReturn: () => trainer.resume(),
      onEnd: () => {
        const left = trainer.discardSuspended();
        if (left > 0) toast(`Training session ended with ${plural(left, 'line')} still to go.`);
      },
    },
  });
}

const puzzles = new PuzzleController({
  game,
  board,
  render: () => render(),
  onModeChange: (active) => {
    trainingMode(active, 'Puzzle', 'puzzling');
    if (active) repertoire.setCommentsVisible(false); // repertoire notes don't belong to puzzles
  },
  onLock: (locked) => {
    // While solving, the engine would give the answer away; afterwards it's free to analyse.
    if (locked) analysis.pause('puzzle');
    else analysis.resume('puzzle');
    document.body.classList.toggle('puzzle-locked', locked);
  },
  onOpenGame: async (gameId, ply) => {
    puzzles.stop();
    if (!(await gamePanel.open(gameId))) return;
    game.goTo(Math.min(ply, game.moves.length));
    render();
  },
});

/** The board belongs to a training line or an unsolved puzzle: no navigation or free moves. */
const locked = () => trainer.active || puzzles.locked;

const puzzlesView = new PuzzlesView({
  onStart: async (theme) => {
    if (!(await startBoardMode())) return;
    setView('board');
    puzzles.start(theme);
  },
  onRetry: async (id) => {
    if (!(await startBoardMode())) return;
    setView('board');
    puzzles.open(id);
  },
  onStartOwn: async (list) => {
    if (!(await startBoardMode())) return;
    setView('board');
    puzzles.startOwn(list);
  },
  onReviewGames: () => {
    setView('games');
    gamesView.reviewAll();
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
  // A reviewed game opens with its evaluation graph and move marks (from the saved analysis).
  onOpened: (data) => {
    if (data.review) review.showSaved(data.review.movetime_ms);
  },
});

const gamesView = new GamesView({
  panel: gamePanel,
  game,
  onOpen: async (id) => {
    if (!(await play.confirmStop())) return;
    if (await gamePanel.open(id)) setView('board');
  },
  analysis,
});

// ---- repertoire in the wild ------------------------------------------------------

/** Put moves from the start on the board (asking first if that ends a game vs the engine or loses edits). */
async function showMoves({ ucis = [], sans = [], ply = null }) {
  if (!(await play.confirmStop())) return false;
  if (!(await gamePanel.confirmLeave())) return false;
  game.load(START_FEN);
  for (const san of sans) if (!game.playSan(san)) break;
  for (const uci of ucis) if (!game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4])) break;
  if (ply !== null) game.goTo(Math.min(ply, game.moves.length));
  return true;
}

const wildView = new WildView({
  repertoire,
  onOpen: async (id, ply) => {
    if (!(await play.confirmStop())) return;
    const g = await gamePanel.openWild(id, ply);
    if (!g) return;
    setView('board');
    render();
    toast(`At the watched position (move ${Math.ceil(ply / 2)}). Step on through the game, or review it with the engine.`);
  },
  onShowPosition: async (sans) => {
    if (!(await showMoves({ sans }))) return;
    setView('board');
    render();
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
  isBusy: () => locked() || play.active,
  onJump: (ply) => {
    if (locked() || play.active) return;
    game.goTo(ply);
    render();
  },
  onChanged: () => render(),
  onSaved: (fen, ev) => savedEval.remember(fen, ev),
  onComplete: (r) => saveGameReview(r),
});

/** A finished review of an open saved game's moves becomes that game's review (accuracy, puzzles). */
async function saveGameReview(r) {
  const g = gamePanel.savedGameOnBoard();
  if (!g || r.startFen !== game.startFen) return;
  if (r.ucis.join(' ') !== g.ucis.join(' ')) {
    if (g.ucis.join(' ').startsWith(r.ucis.join(' '))) {
      toast('This review stopped at the board position. Go to the end of the game and review it to mark the game reviewed.');
    }
    return;
  }
  if (!reviewComplete(r.judged, r.ucis.length)) return;
  try {
    const res = await api.saveGameReview(g.id, reviewPayload(r.ucis, r.ms, r.judged, r.evals));
    gamePanel.setReview((await api.game(g.id)).review);
    const found = res.puzzles ? ` ${plural(res.puzzles, 'puzzle')} from your mistakes${res.new ? ` (${res.new} new)` : ''}.` : '';
    toast(`Game marked reviewed.${found}`);
  } catch (err) {
    toast(`Review not saved to the game: ${err.message}`, 'error');
  }
}

/** Training and puzzles replace the board's moves, so an open game is closed first (asking if unsaved). */
async function startBoardMode() {
  if (!(await play.confirmStop())) return false;
  if (!(await gamePanel.confirmLeave())) return false;
  return true;
}

async function startTraining(opening, mode, lineId, tag, label) {
  if (puzzles.active) puzzles.stop();
  if (!(await startBoardMode())) return;
  trainer.start(opening, mode, lineId, tag, label);
}

// ---- views: Board | Dashboard | Games -----------------------------------------------

const VIEWS = { board: 'main.layout', dashboard: '#dashboard', games: '#games-view', wild: '#wild-view', puzzles: '#puzzles-view' };
let view = 'board';

function setView(next) {
  if (next !== 'board' && (trainer.active || puzzles.active)) return;
  view = next;
  for (const [name, sel] of Object.entries(VIEWS)) {
    document.querySelector(sel).hidden = view !== name;
    $(`view-${name}`).setAttribute('aria-pressed', String(view === name));
  }
  store.set('view', view);
  if (view === 'board') {
    board.redraw();
    review.update(); // a graph drawn while the board was hidden is resized to its panel
    analysis.resume('away');
  } else {
    analysis.pause('away'); // the board isn't visible
    if (view === 'dashboard') dashboard.refresh();
    if (view === 'games') gamesView.refresh();
  }
  if (view === 'wild') wildView.refresh();
  else wildView.hide();
  if (view === 'puzzles') puzzlesView.refresh();
  else puzzlesView.hide();
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

/** A click for each move played (or stepped forward); silent for jumps, going back and new games. */
function moveSound() {
  const now = { startFen: game.startFen, ply: game.ply };
  if (movedOneForward(soundState, now)) sounds.playMove(game.moves[game.ply - 1]?.san);
  soundState = now;
}

function render() {
  moveSound();
  board.show(game, {
    canMove: trainer.active ? trainer.canMove() : puzzles.locked ? puzzles.canMove() : play?.active ? play.canMove() : true,
  });
  const status = game.status();
  ui.status.textContent = status.text;
  ui.status.classList.toggle('over', status.over);
  review?.update();
  // Hidden when something else already shows the evaluation (review panel, live engine) or it would give answers away.
  savedEval?.update(game.fen(), Boolean(review?.open) || analysis.settings.on || locked() || Boolean(play?.active));
  renderMoveList(
    ui.moves,
    game,
    (ply) => {
      if (locked()) return; // no peeking ahead while training or solving
      game.goTo(ply);
      render();
    },
    review?.annotations(),
  );
  if (document.activeElement !== ui.fen) ui.fen.value = game.fen();
  const atStart = game.ply === 0 || locked();
  const atEnd = game.ply === game.moves.length || locked();
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
  if (puzzles.locked) {
    puzzles.onUserMove(from, to, promotion);
    return;
  }
  if (play.active && !play.canMove()) return render();
  game.play(from, to, promotion);
  render();
}

function step(action) {
  if (locked()) return; // navigation is locked while training or solving
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
  if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    toggleSound(); // works while training or solving too
    return;
  }
  const action = locked() && e.key !== 'f' ? null : actions[e.key];
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
    if (locked()) return;
    step(() => (e.deltaY > 0 ? game.forward() : game.back()));
  },
  { passive: false },
);

// ---- board tools --------------------------------------------------------

$('btn-flip').addEventListener('click', () => board.flip());

function showSound() {
  const b = $('btn-sound');
  b.textContent = sounds.enabled ? 'Sound on' : 'Sound off';
  b.setAttribute('aria-pressed', String(sounds.enabled));
}
function toggleSound() {
  sounds.setEnabled(!sounds.enabled);
  showSound();
  if (sounds.enabled) sounds.play('move');
}
$('btn-sound').addEventListener('click', toggleSound);
showSound();
// Training and puzzles report right and wrong answers.
document.addEventListener('mpct:sound', (e) => sounds.play(e.detail));
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
  const openWild = store.get('openWild');
  if (openGameId) await gamePanel.open(openGameId);
  else if (openWild) {
    const ply = game.ply; // keep where you were in it
    if (await gamePanel.openWild(openWild.id, ply)) render();
  }
  const saved = store.get('view');
  if (saved && saved !== 'board' && VIEWS[saved]) setView(saved);
  await review.restore();
  render();
  wildView.checkNew();
});

// Expose for debugging in the browser console.
window.mpct = { game, board, sounds, repertoire, trainer, puzzles, puzzlesView, dashboard, wildView, setView, render, analysis, gamePanel, gamesView, play, review, savedEval };
