// Thin client for the MPCT JSON API. Every call returns parsed JSON (or null for 204)
// and throws ApiError with the server's message on failure.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Search text and game filters as query parameters, leaving out empty ones. */
export function gameParams(q = '', filters = {}) {
  return Object.fromEntries(Object.entries({ q, ...filters }).filter(([, v]) => v));
}

async function request(method, path, { body, params } = {}) {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    let message = data?.detail ?? `Request failed (${res.status})`;
    if (Array.isArray(message)) message = message.map((d) => d.msg).join('; '); // validation errors
    throw new ApiError(res.status, message);
  }
  return data;
}

export const api = {
  health: () => request('GET', '/health'),

  repertoires: () => request('GET', '/repertoires'),
  createRepertoire: (name) => request('POST', '/repertoires', { body: { name } }),
  renameRepertoire: (id, name) => request('PATCH', `/repertoires/${id}`, { body: { name } }),
  deleteRepertoire: (id) => request('DELETE', `/repertoires/${id}`),

  openings: (repId) => request('GET', `/repertoires/${repId}/openings`),
  createOpening: (repId, name, color) => request('POST', `/repertoires/${repId}/openings`, { body: { name, color } }),
  updateOpening: (id, changes) => request('PATCH', `/openings/${id}`, { body: changes }),
  deleteOpening: (id) => request('DELETE', `/openings/${id}`),

  addLine: (openingId, moves) => request('POST', `/openings/${openingId}/lines`, { body: { moves } }),
  countLinesThrough: (openingId, fen) => request('GET', `/openings/${openingId}/lines/through`, { params: { fen } }),
  deleteLinesThrough: (openingId, fen) => request('DELETE', `/openings/${openingId}/lines/through`, { params: { fen } }),

  explorer: (openingId, fen) => request('GET', `/openings/${openingId}/explorer`, { params: { fen } }),

  training: (openingId, mode = 'due', lineId = null, tagId = null) =>
    request('GET', `/openings/${openingId}/training`, {
      params: Array.isArray(lineId)
        ? { line_ids: lineId.join(',') }
        : lineId
          ? { line_id: lineId }
          : { mode, ...(tagId ? { tag_id: tagId } : {}) },
    }),
  recordReview: (lineId, practice, attempts) =>
    request('POST', `/lines/${lineId}/reviews`, { body: { practice, attempts } }),

  dashboard: (openingId, tagId = null) =>
    request('GET', `/openings/${openingId}/dashboard`, { params: tagId ? { tag_id: tagId } : {} }),

  overview: (repertoireId) => request('GET', `/repertoires/${repertoireId}/overview`),
  activity: (tz, days = 182) => request('GET', '/activity', { params: { tz, days } }),

  tags: (openingId) => request('GET', `/openings/${openingId}/tags`),
  createTag: (openingId, name, fen) => request('POST', `/openings/${openingId}/tags`, { body: { name, fen } }),
  renameTag: (tagId, name) => request('PATCH', `/tags/${tagId}`, { body: { name } }),
  deleteTag: (tagId) => request('DELETE', `/tags/${tagId}`),
  resetLine: (lineId) => request('POST', `/lines/${lineId}/reset`),
  resetOpening: (openingId) => request('POST', `/openings/${openingId}/reset`),
  deleteAllLines: (openingId) => request('DELETE', `/openings/${openingId}/lines`),
  deleteLine: (lineId) => request('DELETE', `/lines/${lineId}`),
  setBookmark: (lineId, note = null) => request('PUT', `/lines/${lineId}/bookmark`, { body: { note } }),
  removeBookmark: (lineId) => request('DELETE', `/lines/${lineId}/bookmark`),

  games: (q = '', filters = {}) => request('GET', '/games', { params: gameParams(q, filters) }),
  gamePlayers: (category = '') => request('GET', '/games/players', { params: category ? { category } : {} }),
  gameGroups: () => request('GET', '/games/groups'),
  gamesExplorer: (fen, groups) => request('GET', '/games-explorer', { params: { fen, groups: groups.join(',') } }),
  game: (id) => request('GET', `/games/${id}`),
  createGame: (data) => request('POST', '/games', { body: data }),
  updateGame: (id, data) => request('PATCH', `/games/${id}`, { body: data }),
  deleteGame: (id) => request('DELETE', `/games/${id}`),
  importCourse: (repertoireId, body) => request('POST', `/repertoires/${repertoireId}/import-course`, { body }),
  // Training tab: courses worked through move by move
  courses: () => request('GET', '/courses'),
  course: (id) => request('GET', `/courses/${id}`),
  importTrainingCourse: (body) => request('POST', '/courses/import', { body }),
  updateCourse: (id, body) => request('PATCH', `/courses/${id}`, { body }),
  deleteCourse: (id) => request('DELETE', `/courses/${id}`),
  resetCourse: (id, chapterId = null) => request('POST', `/courses/${id}/reset`, { body: { chapter_id: chapterId } }),
  exercise: (id) => request('GET', `/exercises/${id}`),
  exerciseAttempt: (id, solved) => request('POST', `/exercises/${id}/attempt`, { body: { solved } }),
  woodpecker: (courseId) => request('GET', `/courses/${courseId}/woodpecker`),
  tablebase: (fen) => request('GET', '/tablebase', { params: { fen } }),
  endgameKp: () => request('GET', '/endgames/kp'),
  endgameAttempt: (body) => request('POST', '/endgames/attempts', { body }),
  endgameStats: () => request('GET', '/endgames/stats'),
  woodpeckerTimes: (courseId) => request('GET', `/courses/${courseId}/woodpecker/times`),
  startWoodpeckerCycle: (courseId, body) => request('POST', `/courses/${courseId}/woodpecker/cycles`, { body }),
  abandonWoodpeckerCycle: (cycleId) => request('DELETE', `/woodpecker/cycles/${cycleId}`),
  woodpeckerAttempt: (cycleId, exerciseId, solved, seconds) =>
    request('POST', `/woodpecker/cycles/${cycleId}/attempts`, { body: { exercise_id: exerciseId, solved, seconds } }),
  importPgn: (pgn, category = 'otb') => request('POST', '/games/import-pgn', { body: { pgn, category } }),
  lichessSettings: () => request('GET', '/lichess/settings'),
  setLichessUsername: (username) => request('PUT', '/lichess/username', { body: { username } }),
  lichessGames: (max = 20) => request('GET', '/lichess/games', { params: { max } }),
  importLichessGame: (id) => request('POST', `/lichess/games/${encodeURIComponent(id)}/import`),
  importLichessLatest: () => request('POST', '/lichess/latest'),
  importLichessNew: (max = 20) => request('POST', '/lichess/import-new', { params: { max } }),
  checkGame: (openingId, moves) => request('POST', `/openings/${openingId}/check`, { body: { moves } }),
  gamePgnUrl: (id) => `/api/games/${id}/pgn`,
  allGamesPgnUrl: (q = '', filters = {}) => {
    const qs = new URLSearchParams(gameParams(q, filters)).toString();
    return `/api/pgn/games${qs ? `?${qs}` : ''}`;
  },

  gaps: (openingId, minShare) => request('GET', `/openings/${openingId}/gaps`, { params: { min_share: minShare } }),
  gapsCheck: (openingId) => request('POST', `/openings/${openingId}/gaps/check`),
  explorerStatus: () => request('GET', '/explorer/status'),
  explorerStop: () => request('POST', '/explorer/stop'),
  drill: (params) => request('GET', '/drill', { params }),
  drillResults: (results) => request('POST', '/drill/results', { body: { results } }),
  evalsLookup: (fens, minMovetimeMs = 0) => request('POST', '/evals/lookup', { body: { fens, min_movetime_ms: minMovetimeMs } }),
  saveEvals: (evals) => request('POST', '/evals', { body: { evals } }),

  watches: (repId, minElo = null) => request('GET', `/repertoires/${repId}/watches`, { params: minElo ? { min_elo: minElo } : {} }),
  openingWatches: (openingId, minElo = null) =>
    request('GET', `/openings/${openingId}/watches`, { params: minElo ? { min_elo: minElo } : {} }),
  watchTag: (tagId) => request('PUT', `/tags/${tagId}/watch`),
  unwatchTag: (tagId) => request('DELETE', `/tags/${tagId}/watch`),
  deleteWatch: (id) => request('DELETE', `/watches/${id}`),
  wildGames: (repId, { watchId = null, q = '', limit = 50, offset = 0, minElo = null, unviewed = false } = {}) =>
    request('GET', `/repertoires/${repId}/wild-games`, {
      params: {
        limit,
        offset,
        ...(watchId ? { watch_id: watchId } : {}),
        ...(q ? { q } : {}),
        ...(minElo ? { min_elo: minElo } : {}),
        ...(unviewed ? { unviewed: true } : {}),
      },
    }),
  wildGame: (id) => request('GET', `/wild-games/${id}`),
  saveWildGame: (id) => request('POST', `/wild-games/${id}/save`),
  markWildViewed: (id) => request('POST', `/wild-games/${id}/viewed`),
  wildGamePgnUrl: (id) => `/api/wild-games/${id}/pgn`,

  voice: () => request('GET', '/voice'),

  masters: (fen) => request('GET', '/masters', { params: { fen } }),
  mastersGame: (id) => request('GET', `/masters/games/${encodeURIComponent(id)}`),
  saveMastersGame: (id) => request('POST', `/masters/games/${encodeURIComponent(id)}/save`),
  mastersGamePgnUrl: (id) => `/api/masters/games/${encodeURIComponent(id)}/pgn`,
  wildStatus: (repId = null, since = null, minElo = null) =>
    request('GET', '/wild/status', {
      params: { ...(repId ? { repertoire_id: repId } : {}), ...(since ? { since } : {}), ...(minElo ? { min_elo: minElo } : {}) },
    }),
  wildRefresh: (repId = null) => request('POST', '/wild/refresh', { params: repId ? { repertoire_id: repId } : {} }),

  puzzleStatus: () => request('GET', '/puzzles/status'),
  puzzleImport: () => request('POST', '/puzzles/import'),
  puzzleThemes: () => request('GET', '/puzzles/themes'),
  puzzleSummary: () => request('GET', '/puzzles/summary'),
  nextPuzzle: (theme = null, exclude = []) =>
    request('GET', '/puzzles/next', { params: { ...(theme ? { theme } : {}), ...(exclude.length ? { exclude: exclude.join(',') } : {}) } }),
  puzzle: (id) => request('GET', `/puzzles/${id}`),
  puzzleAttempt: (id, solved, seconds) => request('POST', `/puzzles/${id}/attempts`, { body: { solved, seconds } }),

  gamePuzzleStatus: () => request('GET', '/game-puzzles/status'),
  gamePuzzles: (due = false) => request('GET', '/game-puzzles', { params: due ? { due: true } : {} }),
  setMyNames: (names) => request('PUT', '/game-puzzles/names', { body: { names } }),
  gameReviewQueue: () => request('GET', '/game-reviews/queue'),
  saveGameReview: (gameId, body) => request('POST', `/game-reviews/${gameId}`, { body }),
  gamePuzzleReview: (id, correct) => request('POST', `/game-puzzles/${id}/reviews`, { body: { correct } }),
  deleteGamePuzzle: (id) => request('DELETE', `/game-puzzles/${id}`),

  comment: (repId, fen) => request('GET', `/repertoires/${repId}/comment`, { params: { fen } }),
  saveComment: (repId, fen, comment) => request('PUT', `/repertoires/${repId}/comment`, { body: { fen, comment } }),
};
