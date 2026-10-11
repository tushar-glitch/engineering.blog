// Progressive enhancement only: every page works without this file.
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Filters apply as soon as they change.
const form = document.getElementById('f');
document.addEventListener('change', (e) => {
  const el = e.target;
  if (form && el.form === form && el.name !== 'q') form.requestSubmit();
});
// Drop empty params so URLs stay clean.
form?.addEventListener('formdata', (e) => {
  for (const [k, v] of [...e.formData]) if (v === '' || (k === 'quality' && v === '6')) e.formData.delete(k);
});

// Search box: Enter submits, Shift+Enter adds a line, "/" focuses.
for (const ta of $$('[data-search]')) {
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ta.form.requestSubmit(); }
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || /input|textarea|select/i.test(document.activeElement.tagName)) return;
  const ta = document.querySelector('[data-search]');
  if (ta) { e.preventDefault(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
});

// Filters collapse into a drawer on small screens.
const filters = document.querySelector('[data-filters]');
if (filters && matchMedia('(max-width: 860px)').matches) filters.open = false;

// Type-to-filter long facet lists and index pages.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('[data-facet-filter]')) {
    const term = el.value.trim().toLowerCase();
    const facet = el.closest('[data-facet]');
    const more = facet.querySelector('.opts-more');
    if (more && term) more.open = true;
    for (const opt of $$('.opt', facet)) opt.hidden = term && !opt.textContent.toLowerCase().includes(term);
  }
  if (el.matches('[data-list-filter]')) {
    const term = el.value.trim().toLowerCase();
    for (const item of $$(`${el.dataset.listFilter} [data-item]`)) item.hidden = term && !item.textContent.toLowerCase().includes(term);
  }
});

// Likes.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-like]');
  if (!btn) return;
  const id = btn.dataset.like;
  const all = $$(`[data-like="${id}"]`);
  const was = btn.getAttribute('aria-pressed') === 'true';
  const n = Number(btn.querySelector('.like-n').textContent);
  const paint = (liked, likes) => all.forEach((b) => {
    b.setAttribute('aria-pressed', String(liked));
    b.querySelector('.like-n').textContent = likes;
  });
  paint(!was, n + (was ? -1 : 1)); // optimistic
  if (!was) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
  try {
    const res = await fetch(`/api/like/${id}`, { method: 'POST' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    paint(data.liked, data.likes);
  } catch {
    paint(was, n);
  }
});

// Saved posts live in this browser only.
const saved = () => store.get('saved', []);
const paintSaved = () => {
  const ids = new Set(saved());
  for (const b of $$('[data-save]')) {
    const on = ids.has(b.dataset.save);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Remove from saved' : 'Save for later';
  }
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const id = btn.dataset.save;
  const ids = saved();
  store.set('saved', ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids]);
  paintSaved();
});
paintSaved();
if (location.pathname === '/saved' && !new URLSearchParams(location.search).has('ids') && saved().length) {
  location.replace('/saved?ids=' + saved().join(','));
}

// "Back" returns to the results you came from when possible.
for (const a of $$('[data-back]')) {
  a.addEventListener('click', (e) => {
    if (document.referrer && new URL(document.referrer).origin === location.origin) { e.preventDefault(); history.back(); }
  });
}

// Theme toggle: light <-> dark, remembered.
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
});
