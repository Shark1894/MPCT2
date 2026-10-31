// Small shared UI helpers: modal form/confirm dialogs, a toast, and safe localStorage.

let dialogEl;

function getDialog() {
  if (!dialogEl) {
    dialogEl = document.createElement('dialog');
    dialogEl.className = 'modal';
    document.body.appendChild(dialogEl);
  }
  return dialogEl;
}

/**
 * Show a modal form. fields: [{ name, label, type: 'text' | 'select', value, options: [[value, label]] }]
 * Resolves to { name: value, ... } or null if cancelled.
 */
export function formDialog({ title, message = '', fields = [], submit = 'Save', danger = false }) {
  const dlg = getDialog();
  dlg.innerHTML = '';
  const form = document.createElement('form');
  form.method = 'dialog';

  const h = document.createElement('h2');
  h.textContent = title;
  form.appendChild(h);

  if (message) {
    const p = document.createElement('p');
    p.className = 'modal-message';
    p.textContent = message;
    form.appendChild(p);
  }

  for (const f of fields) {
    const label = document.createElement('label');
    label.className = 'modal-field';
    const span = document.createElement('span');
    span.textContent = f.label;
    label.appendChild(span);
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [value, text] of f.options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.required = true;
      input.maxLength = 100;
      input.autocomplete = 'off';
    }
    input.name = f.name;
    if (f.value !== undefined) input.value = f.value;
    label.appendChild(input);
    form.appendChild(label);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.textContent = submit;
  ok.className = danger ? 'danger' : 'primary';
  actions.append(cancel, ok);
  form.appendChild(actions);
  dlg.appendChild(form);

  return new Promise((resolve) => {
    let result = null;
    cancel.addEventListener('click', () => dlg.close());
    form.addEventListener('submit', () => {
      result = Object.fromEntries(new FormData(form).entries());
      for (const key of Object.keys(result)) result[key] = String(result[key]).trim();
    });
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    (form.querySelector('input, select') ?? ok).focus();
  });
}

export async function confirmDialog(title, message, confirmLabel = 'Delete') {
  return (await formDialog({ title, message, submit: confirmLabel, danger: true })) !== null;
}

export function isModalOpen() {
  return Boolean(dialogEl?.open);
}

// ---- opening picker -----------------------------------------------------------

/** Fill a <select> with openings grouped under "White" and "Black" headings, A to Z within each. */
export function fillOpeningSelect(select, openings) {
  select.innerHTML = '';
  for (const [color, label] of [
    ['white', 'White'],
    ['black', 'Black'],
  ]) {
    const group = openings.filter((o) => o.color === color).sort((a, b) => a.name.localeCompare(b.name));
    if (group.length === 0) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    for (const o of group) optgroup.appendChild(new Option(o.name, o.id));
    select.appendChild(optgroup);
  }
}

// ---- dates ----------------------------------------------------------------

function localIsoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from today (local) to an ISO date (YYYY-MM-DD); negative = in the past. */
export function daysFromToday(isoDate) {
  return Math.round((Date.parse(isoDate) - Date.parse(localIsoToday())) / 864e5);
}

/** 'Today', 'Tomorrow', 'In 5 days', 'Overdue 2 days' for a review date. */
export function describeDue(isoDate) {
  const days = daysFromToday(isoDate);
  if (days < 0) return `Overdue ${-days} day${days === -1 ? '' : 's'}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---- toast ----------------------------------------------------------------

let toastTimer;

export function toast(text, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2500);
}

// ---- storage (per browser; may be unavailable) -----------------------------

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`mpct.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mpct.${key}`, JSON.stringify(value));
    } catch {
      /* storage blocked or full: not important */
    }
  },
};
