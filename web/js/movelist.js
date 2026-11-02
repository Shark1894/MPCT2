// Move list: numbered rows of SAN moves; clicking a move jumps to it.

export function renderMoveList(container, game, onSelect, annotations = new Map()) {
  const rows = game.moveRows();
  container.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'moves-empty';
    empty.textContent = 'No moves yet. Drag a piece or tap a piece then a square.';
    container.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'move-row';

    const num = document.createElement('span');
    num.className = 'move-num';
    num.textContent = `${row.number}.`;
    line.appendChild(num);

    for (const side of ['white', 'black']) {
      const cell = row[side];
      const el = document.createElement(cell ? 'button' : 'span');
      el.className = 'move';
      if (cell) {
        el.type = 'button';
        el.textContent = cell.san;
        el.dataset.ply = cell.ply;
        const note = annotations.get(cell.ply); // engine review marks
        if (note) {
          if (note.symbol) {
            const sym = document.createElement('span');
            sym.className = `move-mark ${note.cls}`;
            sym.textContent = note.symbol;
            el.appendChild(sym);
          }
          if (note.book) el.classList.add('book');
          el.title = note.title;
        }
        if (cell.ply === game.ply) el.classList.add('current');
        el.addEventListener('click', () => onSelect(cell.ply));
      } else {
        el.textContent = side === 'white' ? '…' : '';
        el.classList.add('move-blank');
      }
      line.appendChild(el);
    }
    frag.appendChild(line);
  }
  container.appendChild(frag);

  // Keep the current move visible without scrolling the whole page.
  const current = container.querySelector('.move.current');
  if (current) {
    const top = current.offsetTop - container.offsetTop;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + current.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + current.offsetHeight - container.clientHeight;
    }
  } else if (game.ply === 0) {
    container.scrollTop = 0;
  }
}
