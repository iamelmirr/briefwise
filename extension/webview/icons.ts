// 16px line icons, stroke = currentColor. Trusted constants only.

const P: Record<string, string> = {
  file: `<path d="M4 1.75h4.75L12 5v9.25H4z"/><path d="M8.75 1.75V5H12"/>`,
  edit: `<path d="M10.5 2.75l2.75 2.75L6 12.75H3.25V10z"/><path d="M9 4.25l2.75 2.75"/>`,
  write: `<path d="M4 1.75h4.75L12 5v9.25H4z"/><path d="M8 7.25v4.5M5.75 9.5h4.5"/>`,
  terminal: `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M4.5 6.25L6.5 8l-2 1.75M8.25 10h3"/>`,
  search: `<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.5 3.5"/>`,
  list: `<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.75" cy="4" r=".6" fill="currentColor"/><circle cx="2.75" cy="8" r=".6" fill="currentColor"/><circle cx="2.75" cy="12" r=".6" fill="currentColor"/>`,
  agent: `<path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3"/><circle cx="8" cy="8" r="2"/>`,
  globe: `<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c2.1 2.2 2.1 10.3 0 12.5M8 1.75c-2.1 2.2-2.1 10.3 0 12.5"/>`,
  dot: `<circle cx="8" cy="8" r="2.25"/>`,
  check: `<path d="M3.25 8.5l3 3 6.5-7"/>`,
  x: `<path d="M4 4l8 8M12 4l-8 8"/>`,
  stop: `<rect x="4" y="4" width="8" height="8" rx="1.75" fill="currentColor" stroke="none"/>`,
  send: `<path d="M8 13.25V3M3.5 7.5L8 3l4.5 4.5"/>`,
  plus: `<path d="M8 3v10M3 8h10"/>`,
  rules: `<path d="M3 2.75h7.5a2 2 0 012 2v8.5H5a2 2 0 01-2-2z"/><path d="M3 11.25a2 2 0 012-2h7.5"/>`,
  lock: `<rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5"/><path d="M5.5 7V5.25a2.5 2.5 0 015 0V7"/>`,
  more: `<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>`,
  diff: `<path d="M4.75 2.5v6M1.75 5.5h6M9 12.5h5.5"/>`,
  warn: `<path d="M8 2.25l6.25 11H1.75z"/><path d="M8 6.75v3"/><circle cx="8" cy="11.6" r=".55" fill="currentColor"/>`,
  info: `<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4"/><circle cx="8" cy="5" r=".6" fill="currentColor"/>`,
  shield: `<path d="M8 1.75l5.25 2v4c0 3.4-2.3 5.6-5.25 6.5-2.95-.9-5.25-3.1-5.25-6.5v-4z"/>`,
  chevron: `<path d="M6 4l4 4-4 4"/>`,
  caret: `<path d="M4.5 6.5l3.5 3.5 3.5-3.5"/>`,
  branch: `<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>`,
  resume: `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M6.25 5.75l3.5 2.25-3.5 2.25z"/>`,
  handoff: `<path d="M2 8h10.5M9 4.5L12.5 8 9 11.5"/>`,
  key: `<circle cx="5" cy="10.5" r="2.75"/><path d="M7 8.5l6-6M11 4.5l1.75 1.75"/>`,
  notes: `<path d="M4 1.75h8v12.5H4z"/><path d="M6 5h4M6 8h4M6 11h2"/>`,
};

export type IconName = keyof typeof P;

export function icon(name: string, cls = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `icon${cls ? " " + cls : ""}`;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? P.dot}</svg>`;
  return s;
}
