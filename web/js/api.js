// Thin client for the MPCT JSON API. Every call returns parsed JSON (or null for 204)
// and throws ApiError with the server's message on failure.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
      params: lineId ? { line_id: lineId } : { mode, ...(tagId ? { tag_id: tagId } : {}) },
    }),
  recordReview: (lineId, practice, attempts) =>
    request('POST', `/lines/${lineId}/reviews`, { body: { practice, attempts } }),

  dashboard: (openingId, tagId = null) =>
    request('GET', `/openings/${openingId}/dashboard`, { params: tagId ? { tag_id: tagId } : {} }),

  tags: (openingId) => request('GET', `/openings/${openingId}/tags`),
  createTag: (openingId, name, fen) => request('POST', `/openings/${openingId}/tags`, { body: { name, fen } }),
  renameTag: (tagId, name) => request('PATCH', `/tags/${tagId}`, { body: { name } }),
  deleteTag: (tagId) => request('DELETE', `/tags/${tagId}`),
  resetLine: (lineId) => request('POST', `/lines/${lineId}/reset`),
  resetOpening: (openingId) => request('POST', `/openings/${openingId}/reset`),
  deleteAllLines: (openingId) => request('DELETE', `/openings/${openingId}/lines`),
  deleteLine: (lineId) => request('DELETE', `/lines/${lineId}`),

  comment: (repId, fen) => request('GET', `/repertoires/${repId}/comment`, { params: { fen } }),
  saveComment: (repId, fen, comment) => request('PUT', `/repertoires/${repId}/comment`, { body: { fen, comment } }),
};
