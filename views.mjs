// Server-rendered HTML. `html` escapes every interpolated value unless it is itself `html` output.

class Raw { constructor(s) { this.s = s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const render = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('')
  : v == null || v === false ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]);
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + render(vals[i - 1]) + s));
export const toString = (v) => render(v);
const ASSET_V = Date.now().toString(36); // cache-bust static files on every restart

// ---------- vocabulary / labels ----------

const LABELS = {
  'ml-ai': 'ML & AI', llm: 'LLMs', devops: 'DevOps', 'real-time': 'Real-time', 'compilers-languages': 'Compilers & languages',
  'streaming-media': 'Streaming & media', 'social-media': 'Social media', 'e-commerce': 'E-commerce', adtech: 'Adtech',
  'mobility-logistics': 'Mobility & logistics', 'travel-hospitality': 'Travel & hospitality', 'productivity-saas': 'Productivity SaaS',
  ai: 'AI', 'sre-devops': 'SRE & DevOps', 'eng-manager': 'Engineering managers', 'case-study': 'Case study',
  'deep-dive': 'Deep dive', 'lessons-learned': 'Lessons learned', 'developer-productivity': 'Developer productivity',
  'software-architecture': 'Software architecture', 'cost-optimization': 'Cost optimization', 'engineering-management': 'Engineering management',
};
export const label = (s) => LABELS[s] ?? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/-/g, ' ');

export const FACETS = [
  { key: 'difficulty', label: 'Depth', order: ['beginner', 'intermediate', 'advanced', 'expert'] },
  { key: 'type', label: 'Format' },
  { key: 'domain', label: 'Domain' },
  { key: 'tech', label: 'Core technology', searchable: true, mono: true },
  { key: 'industry', label: 'Industry' },
  { key: 'source', label: 'Source', searchable: true, raw: true },
  { key: 'year', label: 'Published', raw: true, sortByValue: true },
];
const LEVELS = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 };

// ---------- url state ----------

export function toQuery(f, patch = {}) {
  const s = { ...f, ...patch };
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  for (const { key } of FACETS) for (const v of s[key] ?? []) p.append(key, v);
  if (s.quality !== 6) p.set('quality', s.quality);
  if (s.code) p.set('code', '1');
  if (s.metrics) p.set('metrics', '1');
  if (s.sort && s.sort !== 'auto') p.set('sort', s.sort);
  if (s.page > 1) p.set('page', s.page);
  const str = p.toString();
  return str ? '/?' + str : '/';
}
const toggle = (f, key, v) => toQuery(f, { [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v], page: 1 });

// ---------- icons (24px stroke) ----------

const icon = (body, cls = '') => html`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${new Raw(body)}</svg>`;
const I = {
  heart: () => icon('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'),
  bookmark: () => icon('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
  out: () => icon('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
  right: () => icon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  left: () => icon('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  search: () => icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  x: () => icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  flag: () => icon('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>'),
  sliders: () => icon('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  theme: () => icon('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'),
  enter: () => icon('<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>'),
};

// ---------- small parts ----------

const fmtDate = (d) => d ? new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(d) : '';
const fmtNum = (n) => new Intl.NumberFormat('en').format(n);
const mono = (source) => (source.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();

const depth = (lvl) => html`<span class="depth" title="${label(lvl)}"><span class="bars" data-l="${LEVELS[lvl] ?? 2}"><i></i><i></i><i></i><i></i></span>${label(lvl)}</span>`;

const likeBtn = (p, liked) => html`<button class="like" type="button" data-like="${p.id}" aria-pressed="${liked ? 'true' : 'false'}"
  aria-label="Like"><span class="like-icon">${I.heart()}</span><span class="like-n">${p.likes}</span></button>`;
const saveBtn = (p) => html`<button class="icon-btn save" type="button" data-save="${p.id}" aria-pressed="false" title="Save for later" aria-label="Save for later">${I.bookmark()}</button>`;

export function row(p, liked, { compact = false } = {}) {
  const t = p.tags;
  return html`<article class="row${compact ? ' compact' : ''}">
    <div class="row-main">
      <div class="row-meta">
        <span class="mark" aria-hidden="true">${mono(p.source)}</span>
        <a class="src" href="${toQuery({ ...EMPTY, source: [p.source] })}">${p.source}</a>
        ${p.published_at ? html`<span class="sep">/</span><time datetime="${p.published_at.toISOString()}">${fmtDate(p.published_at)}</time>` : ''}
        <span class="sep">/</span><span>${label(t.content_type)}</span>
      </div>
      <h3 class="row-title"><a href="/go/${p.id}" target="_blank" rel="noopener">${p.title}<span class="out">${I.out()}</span></a></h3>
      ${compact ? '' : html`<p class="row-summary">${p.summary}</p>`}
      <div class="row-foot">
        ${t.primary_technologies.map((x) => html`<a class="chip mono" href="${toQuery({ ...EMPTY, tech: [x] })}">${x}</a>`)}
        ${depth(t.difficulty)}
        <span class="score" title="${t.quality_reason}">${t.quality}<small>/10</small></span>
        <a class="more" href="/p/${p.id}">Overview</a>
      </div>
    </div>
    <div class="row-side">${likeBtn(p, liked)}${saveBtn(p)}</div>
  </article>`;
}

export const EMPTY = { q: '', difficulty: [], type: [], domain: [], tech: [], industry: [], source: [], year: [], quality: 6, code: false, metrics: false, sort: 'auto', page: 1 };

// ---------- layout ----------

export function layout({ title, description, body, nav = '', stats }) {
  const full = title ? `${title} · Blogify` : 'Blogify · The best engineering writing, indexed';
  const navLink = (href, text) => html`<a href="${href}"${nav === href ? new Raw(' aria-current="page"') : ''}>${text}</a>`;
  return '<!doctype html>' + render(html`<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${full}</title>
  <meta name="description" content="${description ?? 'A curated, searchable index of the best engineering blog posts: case studies, migrations, postmortems and deep dives from engineering teams worldwide.'}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2316150f'/%3E%3Cpath d='M10 8h7.5a5 5 0 0 1 2.6 9.3A5.3 5.3 0 0 1 18 27h-8z' fill='%23fbfaf7'/%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap">
  <link rel="stylesheet" href="/static/style.css?v=${ASSET_V}">
  <script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>
  <script src="/static/app.js?v=${ASSET_V}" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap header-in">
      <a class="brand" href="/"><span class="brand-mark">B</span>Blogify</a>
      <nav class="nav">
        ${navLink('/', 'Browse')}${navLink('/topics', 'Topics')}${navLink('/sources', 'Sources')}${navLink('/saved', 'Saved')}
      </nav>
      <div class="header-actions">
        <a class="btn btn-quiet" href="/submit">Submit a post</a>
        <button class="icon-btn" type="button" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">${I.theme()}</button>
      </div>
    </div>
  </header>
  <main id="main">${body}</main>
  <footer class="site-footer">
    <div class="wrap footer-in">
      <div>
        <a class="brand" href="/"><span class="brand-mark">B</span>Blogify</a>
        <p>An index of engineering writing. We link to the original post; summaries and tags are machine-generated and community-corrected.</p>
      </div>
      <nav>
        <a href="/about">About</a><a href="/submit">Submit</a><a href="/topics">Topics</a><a href="/sources">Sources</a>
      </nav>
      ${stats ? html`<p class="footer-stats mono">${fmtNum(stats.posts)} posts · ${fmtNum(stats.sources)} sources</p>` : ''}
    </div>
  </footer>
</body>
</html>`);
}

// ---------- browse / home ----------

function facetGroup(facet, counts, f) {
  const selected = f[facet.key];
  let items = counts.map((c) => ({ v: String(c.v), n: c.n }));
  for (const v of selected) if (!items.some((i) => i.v === v)) items.push({ v, n: 0 });
  if (facet.order) items.sort((a, b) => facet.order.indexOf(a.v) - facet.order.indexOf(b.v));
  if (facet.sortByValue) items.sort((a, b) => b.v.localeCompare(a.v));
  if (!items.length) return '';
  const opt = (i) => html`<label class="opt${facet.mono ? ' mono' : ''}">
      <input type="checkbox" name="${facet.key}" value="${i.v}" form="f"${selected.includes(i.v) ? new Raw(' checked') : ''}>
      <span class="opt-label">${facet.raw || facet.mono ? i.v : label(i.v)}</span><span class="opt-n">${fmtNum(i.n)}</span></label>`;
  const head = items.filter((i, idx) => idx < 7 || selected.includes(i.v));
  const rest = items.filter((i) => !head.includes(i));
  return html`<fieldset class="facet" data-facet>
    <legend>${facet.label}${selected.length ? html` <span class="facet-on">${selected.length}</span>` : ''}</legend>
    ${facet.searchable && items.length > 10 ? html`<input class="facet-search" type="search" placeholder="Filter ${facet.label.toLowerCase()}…" data-facet-filter aria-label="Filter ${facet.label}">` : ''}
    <div class="opts">${head.map(opt)}</div>
    ${rest.length ? html`<details class="opts-more"><summary>${rest.length} more</summary><div class="opts">${rest.map(opt)}</div></details>` : ''}
  </fieldset>`;
}

function sidebar(f, facets) {
  const q = (n, text) => html`<label class="seg-opt"><input type="radio" name="quality" value="${n}" form="f"${f.quality === n ? new Raw(' checked') : ''}><span>${text}</span></label>`;
  return html`<details class="filters" open data-filters>
    <summary class="filters-toggle">${I.sliders()} Filters${activeCount(f) ? html` <span class="facet-on">${activeCount(f)}</span>` : ''}</summary>
    <div class="filters-body">
      <fieldset class="facet">
        <legend>Minimum quality</legend>
        <div class="seg">${q(1, 'Any')}${q(5, '5+')}${q(6, '6+')}${q(7, '7+')}${q(8, '8+')}</div>
      </fieldset>
      <fieldset class="facet">
        <legend>Contains</legend>
        <div class="opts">
          <label class="opt"><input type="checkbox" name="code" value="1" form="f"${f.code ? new Raw(' checked') : ''}><span class="opt-label">Code samples</span></label>
          <label class="opt"><input type="checkbox" name="metrics" value="1" form="f"${f.metrics ? new Raw(' checked') : ''}><span class="opt-label">Real numbers &amp; benchmarks</span></label>
        </div>
      </fieldset>
      ${FACETS.map((facet) => facetGroup(facet, facets[facet.key] ?? [], f))}
      <noscript><button class="btn" form="f">Apply filters</button></noscript>
    </div>
  </details>`;
}

const activeCount = (f) => FACETS.reduce((n, { key }) => n + f[key].length, 0) + (f.code ? 1 : 0) + (f.metrics ? 1 : 0) + (f.quality !== 6 ? 1 : 0);

function appliedFilters(f) {
  const chips = [];
  for (const facet of FACETS) for (const v of f[facet.key]) {
    chips.push(html`<a class="applied" href="${toggle(f, facet.key, v)}"><span class="applied-k">${facet.label}</span>${facet.raw || facet.mono ? v : label(v)}${I.x()}</a>`);
  }
  if (f.quality !== 6) chips.push(html`<a class="applied" href="${toQuery(f, { quality: 6, page: 1 })}"><span class="applied-k">Quality</span>${f.quality === 1 ? 'Any' : f.quality + '+'}${I.x()}</a>`);
  if (f.code) chips.push(html`<a class="applied" href="${toQuery(f, { code: false, page: 1 })}">Code samples${I.x()}</a>`);
  if (f.metrics) chips.push(html`<a class="applied" href="${toQuery(f, { metrics: false, page: 1 })}">Real numbers${I.x()}</a>`);
  if (!chips.length) return '';
  return html`<div class="applied-bar">${chips}<a class="clear" href="${toQuery({ ...EMPTY, q: f.q })}">Clear all</a></div>`;
}

function searchBox(f, big) {
  return html`<div class="search${big ? ' search-big' : ''}">
    ${I.search()}
    <textarea name="q" form="f" rows="1" maxlength="500" placeholder="${big ? 'Describe what you want to learn…' : 'Search or describe what you want to learn…'}"
      aria-label="Search" data-search>${f.q}</textarea>
    <button class="search-go" form="f" aria-label="Search">${big ? html`<span class="go-label">Search</span> ${I.enter()}` : I.enter()}</button>
    <kbd class="search-kbd" aria-hidden="true">/</kbd>
  </div>`;
}

const EXAMPLES = [
  'How did streaming platforms handle tens of millions of concurrent live viewers?',
  'Real migrations from Postgres to a distributed database',
  'Postmortems caused by cache stampedes or retry storms',
  'How companies cut their cloud bill by more than 30%',
];

function collectionsGrid(collections) {
  return html`<section class="wrap collections" aria-labelledby="col-h">
    <div class="section-head"><h2 id="col-h">Collections</h2><p>Hand-picked reading paths. Start anywhere.</p></div>
    <div class="col-grid">${collections.map((c, i) => html`<a class="col-card" href="${c.href}">
      <span class="col-n mono">${String(i + 1).padStart(2, '0')}</span>
      <span class="col-title">${c.title}</span>
      <span class="col-desc">${c.desc}</span>
      <span class="col-count mono">${c.count == null ? 'Search' : c.count === 0 ? 'Filling up' : fmtNum(c.count) + (c.count === 1 ? ' post' : ' posts')} ${I.right()}</span>
    </a>`)}</div>
  </section>`;
}

const SORT_LABELS = { relevance: 'Relevance', best: 'Best', liked: 'Most liked', trending: 'Trending this week', newest: 'Newest' };

export function homePage({ f, rows, total, liked, facets, collections, suggestions, stats, sort }) {
  const landing = collections.length > 0;
  const pages = Math.ceil(total / 20);
  const from = (f.page - 1) * 20 + 1;
  const body = html`
    <form id="f" action="/" method="get" data-autosubmit></form>
    ${landing ? html`
      <section class="hero">
        <div class="wrap hero-in">
          <p class="eyebrow mono">${fmtNum(stats.posts)} posts · ${fmtNum(stats.sources)} engineering teams · updated daily</p>
          <h1>How the best engineering teams actually build, <em>indexed.</em></h1>
          <p class="lede">Case studies, migrations, postmortems and deep dives from engineering blogs worldwide. Each post is tagged by technology, depth and domain, and scored for substance. Describe what you want to learn.</p>
          ${searchBox(f, true)}
          <div class="examples"><span>Try</span>${EXAMPLES.map((e) => html`<a href="${toQuery({ ...EMPTY, q: e })}">${e}</a>`)}</div>
        </div>
      </section>
      ${collectionsGrid(collections)}` : ''}
    <section class="wrap browse${landing ? '' : ' browse-top'}" aria-label="Posts">
      ${landing ? '' : html`<div class="browse-search">${searchBox(f, false)}</div>`}
      <div class="browse-grid">
        <aside class="sidebar">${sidebar(f, facets)}</aside>
        <div class="results">
          <div class="results-head">
            <p class="results-count">${landing ? html`<strong>All posts</strong>` : total
              ? html`${f.q ? html`Top matches` : html`<strong>${fmtNum(total)}</strong> posts`}${pages > 1 ? html` <span class="muted">· ${fmtNum(from)}–${fmtNum(Math.min(from + 19, total))}${f.q ? html` of ${fmtNum(total)}` : ''}</span>` : ''}`
              : 'No posts'}</p>
            <label class="sort">Sort
              <select name="sort" form="f">
                ${(f.q ? ['relevance', 'best', 'liked', 'trending', 'newest'] : ['best', 'liked', 'trending', 'newest']).map((s) =>
                  html`<option value="${s}"${s === sort ? new Raw(' selected') : ''}>${SORT_LABELS[s]}</option>`)}
              </select>
            </label>
          </div>
          ${appliedFilters(f)}
          ${suggestions.length ? html`<div class="suggest"><span>Narrow to</span>${suggestions.map(([k, v]) =>
            html`<a href="${toQuery(f, { [k]: [...f[k], v], page: 1 })}">+ ${k === 'tech' ? v : label(v)}</a>`)}</div>` : ''}
          ${rows.length ? html`<div class="rows">${rows.map((p) => row(p, liked.has(p.id)))}</div>` : html`
            <div class="empty">
              <h3>Nothing matches all of that.</h3>
              <p>Try removing a filter or lowering the minimum quality.${stats.pending ? html` ${fmtNum(stats.pending)} more posts are still being reviewed and tagged.` : ''}</p>
              ${activeCount(f) ? html`<a class="btn" href="${toQuery({ ...EMPTY, q: f.q })}">Clear filters</a>` : ''}
            </div>`}
          ${pages > 1 ? html`<nav class="pager" aria-label="Pagination">
            ${f.page > 1 ? html`<a class="btn" href="${toQuery(f, { page: f.page - 1 })}">${I.left()} Previous</a>` : html`<span></span>`}
            <span class="mono muted">Page ${f.page} of ${pages}</span>
            ${f.page < pages ? html`<a class="btn" href="${toQuery(f, { page: f.page + 1 })}">Next ${I.right()}</a>` : html`<span></span>`}
          </nav>` : ''}
        </div>
      </div>
    </section>`;
  return layout({ title: f.q ? f.q.slice(0, 60) : '', body, nav: '/', stats });
}

// ---------- post overview ----------

export function postPage({ p, liked, related, relatedLiked, reported, stats }) {
  const t = p.tags;
  const chips = (key, list) => list.map((x) => html`<a class="chip mono" href="${toQuery({ ...EMPTY, [key]: [x] })}">${x}</a>`);
  const searchChips = (list) => list.map((x) => html`<a class="chip" href="${toQuery({ ...EMPTY, q: x })}">${x}</a>`);
  const body = html`<article class="wrap post">
    <a class="back" href="/" data-back>${I.left()} Back</a>
    <header class="post-head">
      <div class="row-meta">
        <span class="mark" aria-hidden="true">${mono(p.source)}</span>
        <a class="src" href="${toQuery({ ...EMPTY, source: [p.source] })}">${p.source}</a>
        ${p.published_at ? html`<span class="sep">/</span><time datetime="${p.published_at.toISOString()}">${fmtDate(p.published_at)}</time>` : ''}
        ${t.company && t.company.toLowerCase() !== p.source.toLowerCase() ? html`<span class="sep">/</span><span>${t.company}</span>` : ''}
      </div>
      <h1>${p.title}</h1>
      <div class="post-facts">
        <span><small>Format</small>${label(t.content_type)}</span>
        <span><small>Depth</small>${depth(t.difficulty)}</span>
        <span><small>Industry</small>${label(t.industry)}</span>
        <span title="${t.quality_reason}"><small>Quality</small><b class="mono">${t.quality}/10</b></span>
      </div>
      <div class="post-actions">
        <a class="btn btn-primary" href="/go/${p.id}" target="_blank" rel="noopener">Read on ${p.source} ${I.out()}</a>
        ${likeBtn(p, liked)}${saveBtn(p)}
      </div>
      <p class="post-url mono">${new URL(p.url).host}</p>
    </header>

    <div class="post-grid">
      <div class="post-body">
        <section>
          <h2>Summary</h2>
          <p class="post-summary">${p.summary}</p>
          <p class="note">Machine-generated from the original article. Read the full post for the details.</p>
        </section>
        ${t.key_takeaways.length ? html`<section><h2>Key takeaways</h2><ol class="takeaways">${t.key_takeaways.map((k) => html`<li>${k}</li>`)}</ol></section>` : ''}
        ${t.migration ? html`<section><h2>Migration</h2><div class="migration">
          <div>${t.migration.from.map((x) => html`<span class="chip mono">${x}</span>`)}</div><span class="arrow">${I.right()}</span>
          <div>${t.migration.to.map((x) => html`<span class="chip mono">${x}</span>`)}</div></div></section>` : ''}
        ${t.scale_metrics.length ? html`<section><h2>By the numbers</h2><ul class="metrics">${t.scale_metrics.map((m) => html`<li class="mono">${m}</li>`)}</ul></section>` : ''}
        ${t.quality_reason ? html`<section><h2>Why this score</h2><p>${t.quality_reason}</p></section>` : ''}
      </div>
      <aside class="post-side">
        ${t.primary_technologies.length ? html`<div class="side-block"><h3>Core technology</h3><div class="chips">${chips('tech', t.primary_technologies)}</div></div>` : ''}
        ${t.domains.length ? html`<div class="side-block"><h3>Domains</h3><div class="chips">${t.domains.map((x) => html`<a class="chip" href="${toQuery({ ...EMPTY, domain: [x] })}">${label(x)}</a>`)}</div></div>` : ''}
        ${t.technologies.length ? html`<div class="side-block"><h3>Also covers</h3><div class="chips">${searchChips(t.technologies.filter((x) => !t.primary_technologies.includes(x)).slice(0, 16))}</div></div>` : ''}
        ${t.concepts.length ? html`<div class="side-block"><h3>Concepts</h3><div class="chips">${searchChips(t.concepts.slice(0, 16))}</div></div>` : ''}
        ${t.audience.length ? html`<div class="side-block"><h3>Best for</h3><p class="muted">${t.audience.map(label).join(', ')}</p></div>` : ''}
        <details class="report"${reported ? new Raw(' open') : ''}>
          <summary>${I.flag()} Report a problem</summary>
          ${reported ? html`<p class="ok">Thanks. We'll take a look.</p>` : html`
          <form method="post" action="/p/${p.id}/report">
            <label><span>What's wrong?</span>
              <select name="reason" required>
                <option value="broken">Link is broken</option>
                <option value="moved">Post moved to another URL</option>
                <option value="paywall">Paywalled or login required</option>
                <option value="tags">Tags or summary are wrong</option>
                <option value="quality">Not worth listing</option>
                <option value="other">Something else</option>
              </select></label>
            <label><span>Details <small>(optional, e.g. the new URL)</small></span><textarea name="note" rows="3" maxlength="500"></textarea></label>
            <button class="btn">Send report</button>
          </form>`}
        </details>
      </aside>
    </div>

    ${related.length ? html`<section class="related"><h2>Related reading</h2><div class="rows">${related.map((r) => row(r, relatedLiked.has(r.id), { compact: true }))}</div></section>` : ''}
  </article>`;
  return layout({ title: p.title, description: p.summary, body, stats });
}

// ---------- secondary pages ----------

export function topicsPage({ tech, concepts, domains, stats }) {
  const body = html`<div class="wrap page">
    <header class="page-head"><h1>Topics</h1><p>Every technology and concept in the index. Pick one to see the posts that are centrally about it.</p>
      <input class="page-filter" type="search" placeholder="Find a topic…" data-list-filter="#topics" aria-label="Find a topic"></header>
    <div id="topics">
      <section class="topic-sec"><h2>Domains</h2><div class="topic-grid">${domains.map((d) => html`<a href="${toQuery({ ...EMPTY, domain: [d.v] })}" data-item>${label(d.v)}<span class="mono">${d.n}</span></a>`)}</div></section>
      <section class="topic-sec"><h2>Technologies</h2><div class="topic-grid">${tech.map((d) => html`<a class="mono" href="${toQuery({ ...EMPTY, tech: [d.v] })}" data-item>${d.v}<span>${d.n}</span></a>`)}</div></section>
      <section class="topic-sec"><h2>Concepts</h2><div class="topic-grid">${concepts.map((d) => html`<a href="${toQuery({ ...EMPTY, q: d.v })}" data-item>${d.v}<span class="mono">${d.n}</span></a>`)}</div></section>
    </div>
  </div>`;
  return layout({ title: 'Topics', body, nav: '/topics', stats });
}

export function sourcesPage({ sources, stats }) {
  const body = html`<div class="wrap page">
    <header class="page-head"><h1>Sources</h1><p>The engineering blogs we index. Counts include only posts that passed review.</p>
      <input class="page-filter" type="search" placeholder="Find a source…" data-list-filter="#sources" aria-label="Find a source"></header>
    <div class="table-wrap"><table class="table" id="sources">
      <thead><tr><th>Source</th><th class="num">Posts</th><th class="num">Avg. quality</th><th class="num">Latest</th></tr></thead>
      <tbody>${sources.map((s) => html`<tr data-item>
        <td><a href="${toQuery({ ...EMPTY, source: [s.source] })}"><span class="mark" aria-hidden="true">${mono(s.source)}</span>${s.source}</a></td>
        <td class="num mono">${s.n}</td><td class="num mono">${s.avgq ?? '–'}</td><td class="num mono">${fmtDate(s.latest)}</td></tr>`)}</tbody>
    </table></div>
    <p class="muted">Missing a great blog? <a href="/submit?kind=blog">Suggest it</a>.</p>
  </div>`;
  return layout({ title: 'Sources', body, nav: '/sources', stats });
}

export function savedPage({ rows, liked, stats }) {
  const body = html`<div class="wrap page narrow">
    <header class="page-head"><h1>Saved</h1><p>Posts you bookmarked. Stored in this browser only, no account needed.</p></header>
    ${rows.length ? html`<div class="rows" data-saved-list>${rows.map((p) => row(p, liked.has(p.id)))}</div>`
      : html`<div class="empty" data-saved-empty><h3>Nothing saved yet.</h3><p>Use the bookmark icon on any post to keep it here.</p><a class="btn" href="/">Browse posts</a></div>`}
  </div>`;
  return layout({ title: 'Saved', body, nav: '/saved', stats });
}

export function submitPage({ ok, error, existing, kind, stats }) {
  const body = html`<div class="wrap page narrow">
    <header class="page-head"><h1>Submit</h1><p>Know a post or blog that belongs here? We review every submission. We look for real engineering substance: production systems, numbers, trade-offs, lessons.</p></header>
    ${ok ? html`<div class="notice ok">Thanks. Your submission is in the review queue.</div>` : ''}
    ${error ? html`<div class="notice err">${error}${existing ? html` <a href="/p/${existing}">View it</a>.` : ''}</div>` : ''}
    <form class="form" method="post" action="/submit">
      <fieldset class="seg seg-wide">
        <legend class="sr">What are you submitting?</legend>
        <label class="seg-opt"><input type="radio" name="kind" value="post"${kind !== 'blog' ? new Raw(' checked') : ''}><span>A single post</span></label>
        <label class="seg-opt"><input type="radio" name="kind" value="blog"${kind === 'blog' ? new Raw(' checked') : ''}><span>A whole blog</span></label>
      </fieldset>
      <label><span>URL</span><input type="url" name="url" required maxlength="500" placeholder="https://"></label>
      <label><span>Name <small>(optional, for blogs)</small></span><input name="name" maxlength="100" placeholder="e.g. Netflix Tech Blog"></label>
      <label><span>Why is it worth reading? <small>(optional)</small></span><textarea name="note" rows="4" maxlength="1000"></textarea></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <button class="btn btn-primary">Submit for review</button>
    </form>
  </div>`;
  return layout({ title: 'Submit', body, stats });
}

export function aboutPage({ stats }) {
  const body = html`<div class="wrap page narrow prose">
    <h1>About Blogify</h1>
    <p class="lede">Engineering teams publish some of the best technical writing anywhere: how they scaled, what broke, what they migrated and why. It's scattered across hundreds of blogs. Blogify is a single index of it.</p>
    <h2>How posts get in</h2>
    <p>We follow ${fmtNum(stats.sources)} engineering blogs. Every new post is read by a language model that writes a short summary, tags it (core technologies, concepts, domain, industry, format, depth) and scores it from 1 to 10 for substance. By default you only see posts scoring 6 or higher. Marketing, hiring and event posts are excluded.</p>
    <h2>What we don't do</h2>
    <p>We don't republish articles. Every title links to the original, and the summary exists to help you decide whether to click. No accounts, no tracking beyond an anonymous cookie that remembers your likes.</p>
    <h2>How you can help</h2>
    <ul>
      <li><strong>Like</strong> the posts that taught you something. Likes feed the "Best" and "Trending" rankings.</li>
      <li><strong>Report</strong> broken links, wrong tags or posts that don't belong (every post has a "Report a problem" link).</li>
      <li><a href="/submit">Submit</a> posts and blogs we're missing.</li>
    </ul>
  </div>`;
  return layout({ title: 'About', body, stats });
}

export function adminPage({ counts, submissions, reports, stats }) {
  const act = (fields, text, cls = '') => html`<form method="post" action="/admin" class="inline">
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="btn ${cls}">${text}</button></form>`;
  const body = html`<div class="wrap page">
    <header class="page-head"><h1>Moderation</h1>
      <p class="mono">${counts.map((c) => `${c.status}: ${c.n}`).join(' · ')}</p></header>
    <section class="topic-sec"><h2>Submissions (${submissions.length})</h2>
      ${submissions.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Kind</th><th>URL</th><th>Note</th><th></th></tr></thead><tbody>
        ${submissions.map((s) => html`<tr><td>${s.kind}</td><td><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.url}</a>${s.name ? html`<br><small>${s.name}</small>` : ''}</td>
          <td>${s.note}</td><td class="actions">${act({ action: 'approve', id: s.id }, 'Approve', 'btn-primary')}${act({ action: 'reject', id: s.id }, 'Reject')}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">Queue is empty.</p>`}
    </section>
    <section class="topic-sec"><h2>Reports (${reports.length})</h2>
      ${reports.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Post</th><th>Reason</th><th>Note</th><th></th></tr></thead><tbody>
        ${reports.map((r) => html`<tr><td><a href="/p/${r.post_id}">${r.title}</a><br><small class="mono">${r.url}</small></td><td>${r.reason}</td><td>${r.note}</td>
          <td class="actions">${act({ action: 'resolve', id: r.id }, 'Resolve')}${act({ action: 'hide', id: r.id, post: r.post_id }, 'Hide post')}
          <form method="post" action="/admin" class="inline"><input type="hidden" name="action" value="move"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="post" value="${r.post_id}">
          <input type="url" name="url" placeholder="New URL" required><button class="btn">Update URL</button></form></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">No open reports.</p>`}
    </section>
  </div>`;
  return layout({ title: 'Moderation', body, stats });
}

export function notFoundPage({ stats }) {
  return layout({ title: 'Not found', stats, body: html`<div class="wrap page narrow"><div class="empty"><h3>That page doesn't exist.</h3><p>It may have been removed, or the link is wrong.</p><a class="btn" href="/">Browse posts</a></div></div>` });
}
