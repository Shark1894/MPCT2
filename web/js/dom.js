// Small DOM builders shared by the Training tab's pages: elements, buttons, mini boards,
// progress rings and breadcrumbs.

import { boardSquares, ringDash } from './training-core.js';

const SVG = 'http://www.w3.org/2000/svg';

/** An element with a class and text. */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** A real <button> with a click handler. */
export function button(label, cls, onClick, title) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** A static mini board for a FEN (labelled for screen readers). */
export function miniBoard(fen, label = 'Position', flipped = false) {
  const b = el('div', 'mb');
  b.setAttribute('role', 'img');
  b.setAttribute('aria-label', label);
  for (const s of boardSquares(fen, flipped)) {
    const sq = el('span', `mb-sq ${s.light ? 'l' : 'd'}`);
    if (s.glyph) sq.appendChild(el('span', `mb-p ${s.white ? 'w' : 'b'}`, s.glyph));
    b.appendChild(sq);
  }
  return b;
}

function svg(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Progress rings (decorative): rings = [{p: 0-1, cls}] from the outside in, each `gap` px inside
 * the last; text in the middle optional.
 */
export function rings(size, list, { width = 6, gap = 10, text = '', sub = '' } = {}) {
  const s = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', class: 'ring' });
  const c = size / 2;
  list.forEach((ring, i) => {
    const r = c - width / 2 - 1 - i * gap;
    if (r <= width) return;
    s.appendChild(svg('circle', { cx: c, cy: c, r, class: 'ring-track', 'stroke-width': ring.width ?? width }));
    if (ring.p > 0) {
      s.appendChild(
        svg('circle', {
          cx: c,
          cy: c,
          r,
          class: `ring-fill ${ring.cls ?? ''}`,
          'stroke-width': ring.width ?? width,
          'stroke-dasharray': ringDash(r, ring.p),
          transform: `rotate(-90 ${c} ${c})`,
        }),
      );
    }
  });
  if (text) {
    const t = svg('text', { x: c, y: sub ? c + 2 : c + 8, 'text-anchor': 'middle', class: 'ring-text' });
    t.textContent = text;
    s.appendChild(t);
  }
  if (sub) {
    const t = svg('text', { x: c, y: c + 22, 'text-anchor': 'middle', class: 'ring-sub' });
    t.textContent = sub;
    s.appendChild(t);
  }
  return s;
}

/** A line chart path for points "x,y x,y" (decorative unless labelled). */
export function sparkline(points, w, h, label) {
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'spark', preserveAspectRatio: 'none' });
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  s.appendChild(svg('polyline', { points, class: 'spark-line' }));
  const last = points.split(' ').at(-1)?.split(',');
  if (last?.length === 2) s.appendChild(svg('circle', { cx: last[0], cy: last[1], r: 4, class: 'spark-dot' }));
  return s;
}

/** Training › … breadcrumb; crumbs = [[label, onClick|null], ...] (the last is the page). */
export function breadcrumb(crumbs) {
  const nav = el('nav', 'tr-crumbs');
  nav.setAttribute('aria-label', 'Breadcrumb');
  crumbs.forEach(([label, go], i) => {
    if (i) nav.appendChild(el('span', 'tr-crumb-sep', '›')).setAttribute('aria-hidden', 'true');
    if (go) nav.appendChild(button(label, 'tr-crumb', go));
    else nav.appendChild(el('span', 'tr-crumb-here', label));
  });
  return nav;
}

/** A little dice icon (inline SVG) for "random every time". */
export function diceIcon(size = 14) {
  const s = svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': 'true' });
  s.appendChild(svg('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }));
  for (const [x, y] of [[8.5, 8.5], [15.5, 15.5], [15.5, 8.5], [8.5, 15.5]]) s.appendChild(svg('circle', { cx: x, cy: y, r: 1.3, fill: 'currentColor' }));
  return s;
}
