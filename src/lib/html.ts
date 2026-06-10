/** Tiny server-rendered HTML helpers. No framework — just strings + escaping.
 *  Theme: felt-green table, cream "card" panel, oxblood accents. */

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
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         color: #26211b;
         background: #0c3527 radial-gradient(120% 90% at 50% -10%, #19654a 0%, #0c3527 55%, #07251a 100%) fixed; }
  header.site { max-width: 760px; margin: 0 auto; padding: 1rem 1.2rem .85rem;
                display: flex; align-items: center; gap: .9rem; flex-wrap: wrap; }
  .brand { color: #f7f1e3; text-decoration: none; font: 700 1.15rem Georgia, serif; letter-spacing: .02em;
           display: inline-flex; align-items: center; }
  .brand .spade { display: inline-flex; width: 1.65rem; height: 1.65rem; border-radius: .4rem;
                  background: #f7f1e3; color: #14211b; align-items: center; justify-content: center;
                  margin-right: .5rem; font-size: 1.05rem; }
  nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-left: auto; }
  nav a { color: #ecdfc3; text-decoration: none; font-size: .95rem;
          border-bottom: 2px solid transparent; padding-bottom: 1px; }
  nav a:hover { border-bottom-color: #ecdfc3; }
  main { max-width: 760px; margin: 0 auto 2.5rem; padding: 1.35rem 1.4rem 2rem;
         background: #faf6ec; border-radius: 16px; box-shadow: 0 12px 34px #00000061; }
  @media (max-width: 780px) { main { margin-inline: .6rem; } }
  h1 { font: 700 1.45rem Georgia, serif; margin: .2rem 0 1rem; color: #19342a; }
  h2 { font-size: 1.02rem; margin: 1.6rem 0 .55rem; color: #5b2227;
       text-transform: uppercase; letter-spacing: .06em; }
  h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
  a { color: #7c2128; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .45rem; border-bottom: 1px solid #e2d8c4; }
  th { font-size: .76rem; text-transform: uppercase; letter-spacing: .05em; color: #6b6254; }
  tr.r1 td { background: #f3e7c4; font-weight: 700; font-size: 1.05em; }
  tr.r2 td { background: #f1ead7; font-weight: 600; }
  tr.r3 td { background: #f4efe2; }
  form.stack { display: grid; gap: .6rem; max-width: 26rem; }
  label { display: grid; gap: .2rem; font-size: .9rem; }
  input, select, button { font: inherit; padding: .55rem .6rem; border: 1px solid #c9bda6;
                          border-radius: .45rem; background: #fff; color: inherit; }
  button { cursor: pointer; font-weight: 600; background: #f3ecdd; }
  button.primary { background: #7c2128; color: #fff; border-color: #7c2128; }
  button.danger { background: #fff; color: #9c1f1f; border-color: #c98a8a; }
  :focus-visible { outline: 2px solid #7c2128; outline-offset: 2px; }
  .row { display: flex; align-items: center; gap: .6rem; padding: .35rem 0; }
  .row input[type=checkbox] { width: 1.2rem; height: 1.2rem; }
  .muted { color: #6b6254; font-size: .9rem; }
  .pill { display: inline-block; padding: .05rem .5rem; border: 1px solid #c9bda6;
          border-radius: 1rem; font-size: .78rem; background: #fff; }
  details.menu { position: relative; display: inline-block; }
  details.menu summary { list-style: none; cursor: pointer; padding: .15rem .55rem;
                         border: 1px solid #c9bda6; border-radius: .45rem;
                         background: #f3ecdd; font-weight: 700; }
  details.menu summary::-webkit-details-marker { display: none; }
  details.menu .menu-body { position: absolute; right: 0; z-index: 5; margin-top: .25rem;
                            display: grid; gap: .35rem; padding: .5rem; background: #fff;
                            border: 1px solid #c9bda6; border-radius: .5rem;
                            box-shadow: 0 6px 18px #0003; min-width: 8rem; }
  details.menu .menu-body button { width: 100%; }
  .chip { display: inline-block; padding: .03rem .45rem; border: 1px solid #0c352733;
          border-radius: 1rem; font-size: .72rem; background: #0c35270d; color: #234d3d;
          margin-left: .35rem; white-space: nowrap; }
  .legend { list-style: none; padding: 0; margin: .5rem 0 0; display: grid; gap: .25rem;
            font-size: .85rem; color: #6b6254; }
  .legend li { display: flex; align-items: center; gap: .4rem; }
  .legend .chip { margin-left: 0; }
  .card { display: inline-flex; align-items: center; justify-content: center; min-width: 1.75rem;
          padding: .1rem .32rem; border: 1px solid #00000038; border-radius: .35rem;
          background: #fff; color: #111; font: 700 .85rem/1 Georgia, serif;
          box-shadow: 0 1px 2px #0002; }
  .card small { font-size: .78em; margin-left: 1px; }
  .hero { display: flex; align-items: center; gap: .8rem; background: #0c3527; color: #f7f1e3;
          padding: .85rem 1rem; border-radius: 12px; margin: 0 0 1.2rem; }
  .hero .card { min-width: 2.3rem; font-size: 1.25rem; padding: .32rem .42rem; }
  .hero strong { font-family: Georgia, serif; font-size: 1.15rem; }
  .hero .muted { color: #cfe3d6; }
  @media (max-width: 480px) {
    .hero { padding: .6rem .75rem; gap: .6rem; margin-bottom: .9rem; }
    .hero .card { min-width: 1.9rem; font-size: 1.05rem; padding: .25rem .35rem; }
    .hero strong { font-size: 1.02rem; }
  }
  .ok { color: #1d7a3f; } .warn { color: #a05a00; }
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
    `<body><header class="site"><a class="brand" href="/"><span class="spade">♠</span>Poppa P&#39;s</a>${nav}</header>` +
    `<main>${body}</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export const adminNav =
  `<nav><a href="/admin/games">Games</a><a href="/admin/standings">Standings</a>` +
  `<a href="/admin/tournament">Tournament</a><a href="/admin/roster">Roster</a>` +
  `<a href="/">Public&nbsp;↗</a></nav>`;

export const publicNav =
  `<nav><a href="/">Standings</a><a href="/seasons">Seasons</a><a href="/rules">Rules</a></nav>`;
