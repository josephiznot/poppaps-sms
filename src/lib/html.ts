/** Tiny server-rendered HTML helpers. No framework — just strings + escaping. */

/** Escape user-supplied text before putting it in HTML. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --bd:#8884; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem;
         max-width: 720px; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: .2rem 0 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  nav { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem;
        padding-bottom: .75rem; border-bottom: 1px solid var(--bd); }
  nav a { text-decoration: none; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid var(--bd); }
  th { font-size: .8rem; text-transform: uppercase; opacity: .7; }
  form.stack { display: grid; gap: .6rem; max-width: 26rem; }
  label { display: grid; gap: .2rem; font-size: .9rem; }
  input, select, button { font: inherit; padding: .55rem .6rem; border: 1px solid var(--bd);
                          border-radius: .4rem; background: transparent; color: inherit; }
  button { cursor: pointer; font-weight: 600; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .row { display: flex; align-items: center; gap: .6rem; padding: .35rem 0; }
  .row input[type=checkbox] { width: 1.2rem; height: 1.2rem; }
  .muted { opacity: .65; font-size: .9rem; }
  .pill { display: inline-block; padding: .05rem .5rem; border: 1px solid var(--bd);
          border-radius: 1rem; font-size: .78rem; }
  .card { display: inline-flex; align-items: center; justify-content: center; min-width: 1.7rem;
          padding: .08rem .3rem; border: 1px solid #00000033; border-radius: .35rem;
          background: #fff; color: #111; font: 700 .85rem/1 Georgia, serif; }
  .card small { font-size: .78em; margin-left: 1px; }
  .ok { color: #16a34a; } .warn { color: #d97706; }
`;

// Ace-of-spades favicon (inline SVG data URI — no asset file needed).
const FAVICON =
  `<link rel="icon" href="data:image/svg+xml,` +
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>` +
  `<rect width='100' height='100' rx='20' fill='%23111'/>` +
  `<text x='50' y='73' font-size='66' text-anchor='middle' fill='%23fff'>♠</text>` +
  `<text x='23' y='33' font-size='26' text-anchor='middle' font-family='Georgia,serif' fill='%23fff'>A</text>` +
  `</svg>">`;

export function layout(title: string, body: string, nav = ''): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    FAVICON +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body>${nav}${body}</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export const adminNav =
  `<nav><a href="/admin/games">Games</a><a href="/admin/standings">Standings</a>` +
  `<a href="/admin/tournament">Tournament</a><a href="/admin/roster">Roster</a>` +
  `<a href="/">Public&nbsp;↗</a></nav>`;

export const publicNav =
  `<nav><a href="/">Standings</a><a href="/seasons">Seasons</a><a href="/rules">Rules</a></nav>`;
