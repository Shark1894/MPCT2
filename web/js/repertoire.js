// Repertoire panel: repertoire/opening pickers, the move explorer for the current
// position, add/delete line, and position comments (autosaved).

import { api } from './api.js';
import { START_FEN } from './game.js';
import { confirmDialog, fillOpeningSelect, formDialog, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const COLORS = [
  ['white', 'White'],
  ['black', 'Black'],
];

export class RepertoirePanel {
  /**
   * @param {object} opts
   * @param {import('./game.js').Game} opts.game
   * @param {(san: string) => void} opts.onPlaySan      play a move on the board
   * @param {(shapes: object[]) => void} opts.onShapes  draw arrows on the board
   * @param {(color: 'white'|'black') => void} opts.onOrientation
   * @param {(tag: object) => void} opts.onShowTag  move the board to a branch's position
   */
  constructor({ game, onPlaySan, onShapes, onOrientation, onTrain, onJump, onShowTag }) {
    this.game = game;
    this.onPlaySan = onPlaySan;
    this.onShapes = onShapes;
    this.onOrientation = onOrientation;
    this.onTrain = onTrain; // (opening, 'due' | 'all', tag | null) => void
    this.onJump = onJump; // (ply) => void: jump the board to a move
    this.onShowTag = onShowTag;
    this.training = false;
    this.tags = []; // branch tags of the selected opening
    this.watches = []; // branch tags of the selected opening watched in tournament games
    this.tagId = null; // training/dashboard filter: null = all lines

    this.repertoires = [];
    this.openings = [];
    this.repId = null;
    this.openingId = null;
    this.available = true; // false when the API/database is unreachable

    this.token = 0; // guards against out-of-order responses while stepping through moves
    this.refreshTimer = null;
    this.pendingComment = null; // { repId, fen, text, timer }

    this.el = {
      repSelect: $('rep-select'),
      repNew: $('rep-new'),
      openingSelect: $('opening-select'),
      openingNew: $('opening-new'),
      openingInfo: $('opening-info'),
      repRename: $('rep-rename'),
      repDelete: $('rep-delete'),
      openingEdit: $('opening-edit'),
      openingDelete: $('opening-delete'),
      explorer: $('explorer'),
      lineAdd: $('line-add'),
      lineDelete: $('line-delete'),
      commentCurrent: $('comment-current'),
      commentPrevious: $('comment-previous'),
      commentPreviousBox: $('comment-previous-box'),
      commentStatus: $('comment-status'),
      error: $('rep-error'),
      build: $('rep-build'),
      trainDue: $('train-due'),
      trainAll: $('train-all'),
      comments: $('comments'),
      tagFilter: $('train-tag'),
      tagFilterBox: $('train-tag-box'),
      branchPath: $('branch-path'),
      tagAdd: $('tag-add'),
      watchToggle: $('watch-toggle'),
      tagRename: $('tag-rename'),
      tagDelete: $('tag-delete'),
    };
    this._bind();
  }

  // ---- setup ------------------------------------------------------------

  _bind() {
    const e = this.el;
    e.repSelect.addEventListener('change', () => this.selectRepertoire(Number(e.repSelect.value)));
    e.openingSelect.addEventListener('change', () => this.selectOpening(Number(e.openingSelect.value), true));
    e.repNew.addEventListener('click', () => this.newRepertoire());
    e.openingNew.addEventListener('click', () => this.newOpening());
    e.repRename.addEventListener('click', () => this.renameRepertoire());
    e.repDelete.addEventListener('click', () => this.deleteRepertoire());
    e.openingEdit.addEventListener('click', () => this.editOpening());
    e.openingDelete.addEventListener('click', () => this.deleteOpening());
    e.lineAdd.addEventListener('click', () => this.addLine());
    e.lineDelete.addEventListener('click', () => this.deleteLines());
    e.trainDue.addEventListener('click', () => this._opening() && this.onTrain(this._opening(), 'due', this.currentTag()));
    e.trainAll.addEventListener('click', () => this._opening() && this.onTrain(this._opening(), 'all', this.currentTag()));
    e.tagFilter.addEventListener('change', () => {
      this.setTagFilter(e.tagFilter.value ? Number(e.tagFilter.value) : null);
      const tag = this.currentTag();
      if (tag) this.onShowTag?.(tag); // picking a branch on the board view also shows its position
    });
    e.tagAdd.addEventListener('click', () => this.addTag());
    e.watchToggle.addEventListener('click', () => this.toggleWatch());
    e.tagRename.addEventListener('click', () => this.renameTag());
    e.tagDelete.addEventListener('click', () => this.deleteTag());

    e.commentCurrent.addEventListener('input', () => this._commentEdited());
    e.commentCurrent.addEventListener('blur', () => this.flushComment());
    window.addEventListener('pagehide', () => this.flushComment());
  }

  async init() {
    try {
      await this.loadRepertoires(store.get('repertoireId'));
    } catch (err) {
      this._unavailable(err);
    }
  }

  _unavailable(err) {
    this.available = false;
    const msg =
      err.status === 503
        ? 'Database not connected: repertoire features are unavailable. The board still works.'
        : `Repertoire unavailable: ${err.message}`;
    this.el.error.textContent = msg;
    this.el.error.hidden = false;
    for (const el of this.el.error.closest('section').querySelectorAll('button, select, textarea')) el.disabled = true;
  }

  _fail(err) {
    toast(err.message, 'error');
  }

  // ---- repertoires ------------------------------------------------------

  async loadRepertoires(selectId) {
    this.repertoires = await api.repertoires();
    const sel = this.el.repSelect;
    sel.innerHTML = '';
    if (this.repertoires.length === 0) {
      sel.appendChild(new Option('No repertoires yet: press +', ''));
      sel.disabled = true;
      this.repId = null;
      await this._setOpenings([]);
      this._updateButtons();
      return;
    }
    sel.disabled = false;
    for (const r of this.repertoires) sel.appendChild(new Option(r.name, r.id));
    const id = this.repertoires.some((r) => r.id === selectId) ? selectId : this.repertoires[0].id;
    await this.selectRepertoire(id);
  }

  async selectRepertoire(id) {
    this.flushComment();
    this.repId = id;
    this.el.repSelect.value = String(id);
    store.set('repertoireId', id);
    try {
      await this._setOpenings(await api.openings(id), store.get('openingId'));
    } catch (err) {
      this._fail(err);
    }
  }

  async newRepertoire() {
    const values = await formDialog({
      title: 'New repertoire',
      fields: [{ name: 'name', label: 'Name' }],
      submit: 'Create',
    });
    if (!values) return;
    try {
      const rep = await api.createRepertoire(values.name);
      await this.loadRepertoires(rep.id);
      toast(`Created repertoire “${rep.name}”`);
    } catch (err) {
      this._fail(err);
    }
  }

  async renameRepertoire() {
    const rep = this.repertoires.find((r) => r.id === this.repId);
    if (!rep) return;
    const values = await formDialog({
      title: 'Rename repertoire',
      fields: [{ name: 'name', label: 'Name', value: rep.name }],
    });
    if (!values) return;
    try {
      await api.renameRepertoire(rep.id, values.name);
      await this.loadRepertoires(rep.id);
    } catch (err) {
      this._fail(err);
    }
  }

  async deleteRepertoire() {
    const rep = this.repertoires.find((r) => r.id === this.repId);
    if (!rep) return;
    const ok = await confirmDialog(
      `Delete “${rep.name}”?`,
      `This deletes its ${rep.openings} opening(s), every line in them, and all its position comments. It can't be undone.`,
    );
    if (!ok) return;
    try {
      await api.deleteRepertoire(rep.id);
      await this.loadRepertoires(null);
      toast(`Deleted “${rep.name}”`);
    } catch (err) {
      this._fail(err);
    }
  }

  // ---- openings ---------------------------------------------------------

  async _setOpenings(openings, selectId = null) {
    this.openings = openings;
    const sel = this.el.openingSelect;
    sel.innerHTML = '';
    if (openings.length === 0) {
      sel.appendChild(new Option(this.repId ? 'No openings yet: press +' : '—', ''));
      sel.disabled = true;
      this.openingId = null;
      this._renderInfo();
      this._updateButtons();
      this.refresh(true);
      return;
    }
    sel.disabled = false;
    fillOpeningSelect(sel, openings);
    const id = openings.some((o) => o.id === selectId) ? selectId : Number(sel.options[0].value); // top of the list
    this.selectOpening(id, false);
  }

  selectOpening(id, userChose) {
    const changed = id !== this.openingId;
    this.openingId = id;
    if (changed) {
      this.tagId = null;
      this.tags = [];
      this.loadTags();
    }
    this.el.openingSelect.value = String(id);
    store.set('openingId', id);
    this._renderInfo();
    this._updateButtons();
    const opening = this._opening();
    if (opening && (userChose || changed)) this.onOrientation(opening.color);
    this.refresh(true);
  }

  _opening() {
    return this.openings.find((o) => o.id === this.openingId) ?? null;
  }

  async _reloadOpenings() {
    if (!this.repId) return;
    this.loadTags(); // line and due counts per branch may have changed
    this.openings = await api.openings(this.repId);
    const rep = this.repertoires.find((r) => r.id === this.repId);
    if (rep) rep.openings = this.openings.length;
    this._renderInfo();
  }

  _renderInfo() {
    const o = this._opening();
    const tag = this.currentTag();
    const due = tag ? tag.due : o?.due;
    const lines = tag ? tag.lines : o?.lines;
    this.el.trainDue.textContent = o ? `Train due (${due})` : 'Train due';
    this.el.trainDue.disabled = !o || due === 0;
    this.el.trainAll.disabled = !o || lines === 0;
    if (!o) {
      this.el.openingInfo.textContent = '';
      return;
    }
    const parts = [o.color === 'white' ? 'White' : 'Black', `${o.lines} line${o.lines === 1 ? '' : 's'}`];
    if (o.lines) parts.push(o.due ? `${o.due} due` : `next review ${o.next_review_on}`);
    this.el.openingInfo.textContent = parts.join(' · ');
  }

  async newOpening() {
    if (!this.repId) return;
    const values = await formDialog({
      title: 'New opening',
      fields: [
        { name: 'name', label: 'Name' },
        { name: 'color', label: 'You play', type: 'select', options: COLORS, value: this.game.turn() === 'white' ? 'white' : 'black' },
      ],
      submit: 'Create',
    });
    if (!values) return;
    try {
      const o = await api.createOpening(this.repId, values.name, values.color);
      await this._setOpenings(await api.openings(this.repId), o.id);
      this.onOrientation(o.color);
      toast(`Created opening “${o.name}”`);
    } catch (err) {
      this._fail(err);
    }
  }

  async editOpening() {
    const o = this._opening();
    if (!o) return;
    const values = await formDialog({
      title: 'Edit opening',
      fields: [
        { name: 'name', label: 'Name', value: o.name },
        { name: 'color', label: 'You play', type: 'select', options: COLORS, value: o.color },
      ],
    });
    if (!values) return;
    try {
      await api.updateOpening(o.id, values);
      await this._setOpenings(await api.openings(this.repId), o.id);
    } catch (err) {
      this._fail(err);
    }
  }

  async deleteOpening() {
    const o = this._opening();
    if (!o) return;
    const ok = await confirmDialog(
      `Delete “${o.name}”?`,
      `This deletes the opening and its ${o.lines} line(s). It can't be undone.`,
    );
    if (!ok) return;
    try {
      await api.deleteOpening(o.id);
      await this._setOpenings(await api.openings(this.repId));
      toast(`Deleted “${o.name}”`);
    } catch (err) {
      this._fail(err);
    }
  }

  _updateButtons() {
    const e = this.el;
    e.openingNew.disabled = !this.repId;
    e.repRename.disabled = e.repDelete.disabled = !this.repId;
    e.openingEdit.disabled = e.openingDelete.disabled = !this.openingId;
    e.lineAdd.disabled = e.lineDelete.disabled = !this.openingId;
    e.commentCurrent.disabled = !this.repId;
  }

  // ---- lines ------------------------------------------------------------

  async addLine() {
    const o = this._opening();
    if (!o) return;
    if (this.game.startFen !== START_FEN) {
      toast('Lines start from the initial position; this board was set up from a FEN.', 'error');
      return;
    }
    const moves = this.game.moves.slice(0, this.game.ply).map((m) => m.uci);
    if (moves.length === 0) {
      toast('Play some moves first.');
      return;
    }
    try {
      const res = await api.addLine(o.id, moves);
      const n = res.moves_added;
      toast(
        res.status === 'created'
          ? `Added a new line to ${o.name}`
          : res.status === 'extended'
            ? `Extended a line by ${n} move${n === 1 ? '' : 's'}`
            : 'Already in the repertoire',
      );
      await this._reloadOpenings();
      this.refresh(true);
    } catch (err) {
      this._fail(err);
    }
  }

  async deleteLines() {
    const o = this._opening();
    if (!o) return;
    const fen = this.game.fen();
    try {
      const { lines } = await api.countLinesThrough(o.id, fen);
      if (lines === 0) {
        toast('No lines in this opening pass through this position.');
        return;
      }
      const atStart = this.game.ply === 0;
      const ok = await confirmDialog(
        `Delete ${lines} line${lines === 1 ? '' : 's'}?`,
        atStart
          ? `This is the starting position, so this deletes every line in ${o.name}.`
          : `Every line in ${o.name} that passes through this position will be deleted.`,
      );
      if (!ok) return;
      const res = await api.deleteLinesThrough(o.id, fen);
      toast(`Deleted ${res.lines} line${res.lines === 1 ? '' : 's'}`);
      await this._reloadOpenings();
      this.refresh(true);
    } catch (err) {
      this._fail(err);
    }
  }

  // ---- branch tags --------------------------------------------------------

  currentTag() {
    return this.tags.find((t) => t.id === this.tagId) ?? null;
  }

  async loadTags() {
    const openingId = this.openingId;
    if (!openingId) {
      this.tags = [];
      this.watches = [];
    } else {
      try {
        const minElo = Number(store.get('wildMinElo', 0)) || null; // the Wild tab's rating filter
        const [tags, watches] = await Promise.all([api.tags(openingId), api.openingWatches(openingId, minElo).catch(() => [])]);
        if (openingId !== this.openingId) return; // opening changed meanwhile
        this.tags = tags;
        this.watches = watches;
      } catch {
        this.tags = [];
        this.watches = [];
      }
    }
    if (!this.currentTag()) this.tagId = null;
    this._renderTagFilter();
    this._renderInfo();
    this._renderBranches();
    this.onTagsChanged?.();
  }

  setTagFilter(tagId) {
    this.tagId = tagId;
    this._renderTagFilter();
    this._renderInfo();
    this.onTagsChanged?.();
  }

  _renderTagFilter() {
    const sel = this.el.tagFilter;
    sel.innerHTML = '';
    sel.appendChild(new Option('All lines', ''));
    for (const t of this.tags) sel.appendChild(new Option(`${t.name} (${t.lines})`, t.id));
    sel.value = this.tagId ? String(this.tagId) : '';
    this.el.tagFilterBox.hidden = this.tags.length === 0;
  }

  /** Position keys along the current moves: FEN without move counters (matches the server's keys). */
  _pathKeys() {
    const keys = [];
    for (let i = 0; i < this.game.ply; i++) keys.push(this.game.moves[i].fen.split(' ').slice(0, 4).join(' '));
    return keys;
  }

  _tagHere() {
    const key = this.game.fen().split(' ').slice(0, 4).join(' ');
    return this.game.ply > 0 ? (this.tags.find((t) => t.key === key) ?? null) : null;
  }

  _renderBranches() {
    const box = this.el.branchPath;
    box.innerHTML = '';
    const keys = this._pathKeys();
    const onPath = [];
    keys.forEach((key, i) => {
      const t = this.tags.find((tag) => tag.key === key);
      if (t) onPath.push({ tag: t, ply: i + 1 });
    });
    if (onPath.length === 0) {
      const p = document.createElement('p');
      p.className = 'explorer-empty';
      p.textContent = this.openingId
        ? 'No branch tags on these moves. Tag a position to name a branch.'
        : 'Choose an opening to tag its branches.';
      box.appendChild(p);
    }
    onPath.forEach(({ tag, ply }, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'branch-sep';
        sep.textContent = '›';
        box.appendChild(sep);
      }
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'branch-chip';
      if (ply === this.game.ply) chip.classList.add('here');
      chip.textContent = tag.name;
      chip.title = `${tag.lines} line${tag.lines === 1 ? '' : 's'}: jump to this position`;
      chip.addEventListener('click', () => this.onJump(ply));
      box.appendChild(chip);
    });

    const here = this._tagHere();
    this.el.tagAdd.hidden = Boolean(here);
    this.el.tagAdd.disabled = !this.openingId || this.game.ply === 0;
    this.el.tagRename.hidden = this.el.tagDelete.hidden = !here;

    // Only branch tags can be watched: the button sits with the tag's own buttons.
    const watch = here ? this._watchOf(here) : null;
    const wb = this.el.watchToggle;
    wb.hidden = !here;
    wb.setAttribute('aria-pressed', String(Boolean(watch)));
    wb.textContent = watch ? `In the wild: ${watch.games} game${watch.games === 1 ? '' : 's'}` : 'Watch in the wild';
    wb.title = watch
      ? `Watched: tournament games reaching “${here.name}” are listed in the Wild tab. Tap to stop watching.`
      : `Show tournament games that reach “${here?.name ?? ''}” in the Wild tab`;
  }

  _watchOf(tag) {
    return this.watches.find((w) => w.tag_id === tag.id) ?? null;
  }

  async toggleWatch() {
    const tag = this._tagHere();
    if (!tag) return;
    const watch = this._watchOf(tag);
    try {
      if (watch) {
        const ok = await confirmDialog(`Stop watching “${tag.name}”?`, 'Its games disappear from the Wild tab. The tag stays.', 'Unwatch');
        if (!ok) return;
        await api.unwatchTag(tag.id);
        toast(`No longer watching “${tag.name}”`);
      } else {
        const w = await api.watchTag(tag.id);
        toast(
          w.games
            ? `Watching “${tag.name}”: ${w.games} tournament game${w.games === 1 ? '' : 's'} already reach it. See the Wild tab.`
            : `Watching “${tag.name}”. Tournament games that reach it will show in the Wild tab.`,
        );
      }
      await this.loadTags();
    } catch (err) {
      this._fail(err);
    }
  }

  async addTag() {
    const o = this._opening();
    if (!o) return;
    const values = await formDialog({
      title: 'Tag this position',
      message: `Every line in ${o.name} that passes through this position will carry the tag, including lines added later.`,
      fields: [{ name: 'name', label: 'Branch name (e.g. Queen’s Gambit Accepted)' }],
      submit: 'Tag',
    });
    if (!values) return;
    try {
      const tag = await api.createTag(o.id, values.name, this.game.fen());
      toast(`Tagged “${tag.name}” (${tag.lines} line${tag.lines === 1 ? '' : 's'})`);
      await this.loadTags();
    } catch (err) {
      this._fail(err);
    }
  }

  async renameTag() {
    const tag = this._tagHere();
    if (!tag) return;
    const values = await formDialog({ title: 'Rename branch tag', fields: [{ name: 'name', label: 'Name', value: tag.name }] });
    if (!values) return;
    try {
      await api.renameTag(tag.id, values.name);
      await this.loadTags();
    } catch (err) {
      this._fail(err);
    }
  }

  async deleteTag() {
    const tag = this._tagHere();
    if (!tag) return;
    const ok = await confirmDialog(`Remove the tag “${tag.name}”?`, 'Only the tag is removed; the lines stay.', 'Remove tag');
    if (!ok) return;
    try {
      await api.deleteTag(tag.id);
      await this.loadTags();
      toast(`Removed tag “${tag.name}”`);
    } catch (err) {
      this._fail(err);
    }
  }

  // ---- training mode ------------------------------------------------------

  /** In training the explorer (which would give away answers) and editing tools are hidden. */
  async setTraining(active) {
    this.training = active;
    this.el.build.hidden = active;
    this.onShapes([]);
    if (!active) {
      this.setCommentsVisible(true);
      try {
        await this._reloadOpenings(); // due counts changed
      } catch {
        /* shown on next action */
      }
      this.refresh(true);
    }
  }

  setCommentsVisible(visible) {
    this.el.comments.hidden = !visible;
  }

  /** Refresh opening counts (e.g. after training). */
  async reloadOpenings() {
    await this._reloadOpenings();
  }

  // ---- position-dependent content -----------------------------------------

  /** Call whenever the board position changes. */
  positionChanged() {
    if (!this.available) return;
    this._renderBranches();
    this.flushComment();
    if (!this.training) this.onShapes([]);
    this.refresh(this.training); // no debounce in training: positions change one at a time
  }

  refresh(immediate) {
    clearTimeout(this.refreshTimer);
    if (immediate) this._load();
    else this.refreshTimer = setTimeout(() => this._load(), 120); // let rapid stepping settle
  }

  async _load() {
    if (!this.available) return;
    const token = ++this.token;
    const game = this.game;
    const fen = game.fen();
    const prevFen = game.ply > 0 ? (game.ply > 1 ? game.moves[game.ply - 2].fen : game.startFen) : null;
    const repId = this.repId;
    const openingId = this.openingId;

    const [explorer, current, previous] = await Promise.all([
      openingId && !this.training ? api.explorer(openingId, fen).catch((err) => err) : [],
      repId ? api.comment(repId, fen).catch(() => null) : null,
      repId && prevFen ? api.comment(repId, prevFen).catch(() => null) : null,
    ]);
    if (token !== this.token) return; // the position moved on while we waited

    if (!this.training) this._renderExplorer(explorer, openingId);
    // Don't overwrite text being typed for this position since the request went out.
    if (!(this.pendingComment && this.pendingComment.fen === fen)) {
      this.el.commentCurrent.value = current?.comment ?? '';
      this.el.commentStatus.textContent = '';
    }
    this.el.commentPreviousBox.hidden = !prevFen;
    this.el.commentPrevious.value = previous?.comment ?? '';
  }

  _renderExplorer(moves, openingId) {
    const box = this.el.explorer;
    box.innerHTML = '';
    const note = (text) => {
      const p = document.createElement('p');
      p.className = 'explorer-empty';
      p.textContent = text;
      box.appendChild(p);
    };
    if (!openingId) return note(this.repId ? 'Choose or create an opening.' : 'Create a repertoire to get started.');
    if (moves instanceof Error) return note(`Couldn't load moves: ${moves.message}`);
    if (moves.length === 0) {
      return note(
        this.game.startFen !== START_FEN
          ? 'This board was set up from a FEN; repertoire lines start from the initial position.'
          : 'No repertoire moves from this position.',
      );
    }
    for (const m of moves) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'explorer-move';
      btn.innerHTML = `<span class="san"></span><span class="count"></span>`;
      btn.querySelector('.san').textContent = m.san;
      btn.querySelector('.count').textContent = `${m.lines} line${m.lines === 1 ? '' : 's'}`;
      btn.addEventListener('click', () => this.onPlaySan(m.san));
      box.appendChild(btn);
    }
    this.onShapes(moves.map((m) => ({ orig: m.uci.slice(0, 2), dest: m.uci.slice(2, 4), brush: 'green' })));
  }

  // ---- comments -----------------------------------------------------------

  _commentEdited() {
    if (!this.repId) return;
    const p = this.pendingComment ?? { repId: this.repId, fen: this.game.fen() };
    p.text = this.el.commentCurrent.value;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.flushComment(), 800);
    this.pendingComment = p;
    this.el.commentStatus.textContent = 'Unsaved';
  }

  /** Save any unsaved comment now (for the position it was typed in). */
  flushComment() {
    const p = this.pendingComment;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingComment = null;
    const status = this.el.commentStatus;
    status.textContent = 'Saving…';
    api
      .saveComment(p.repId, p.fen, p.text)
      .then(() => {
        if (!this.pendingComment) status.textContent = 'Saved';
      })
      .catch((err) => {
        status.textContent = 'Not saved';
        toast(`Comment not saved: ${err.message}`, 'error');
      });
  }
}
