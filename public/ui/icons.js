// Inline SVG icons: 24×24 grid, stroked with currentColor. Decorative (aria-hidden) unless given a label.
import { esc } from "./format.js";

export const ICONS = {
  // states
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  hand: '<path d="M8 11.5V6a1.5 1.5 0 0 1 3 0v5M11 10V4.5a1.5 1.5 0 0 1 3 0V10M14 10.5V6a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 10a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.7-2.3L4.4 15a1.6 1.6 0 0 1 2.5-2l1.1 1.3V11.5"/>',
  coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M12 3.5v2.5"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  // tools
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  "file-edit": '<path d="M11 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v3"/><path d="M14 3v5h5M18.4 13.6l2 2L15 21h-2v-2z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  "sub-agent": '<circle cx="6.5" cy="6" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M6.5 8.5V13a5 5 0 0 0 5 5H15"/>',
  plan: '<path d="M3.5 6.5l1.5 1.5 3-3M3.5 12.5l1.5 1.5 3-3M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5M5 18.5h.01"/>',
  // status and actions
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  alert: '<path d="M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  // app chrome
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  settings: '<path d="M6 4v5M6 13v7M12 4v1M12 9v11M18 4v9M18 17v3"/><circle cx="6" cy="11" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="18" cy="15" r="2"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  office: '<path d="M12 2.8l8.5 4.9v8.6L12 21.2l-8.5-4.9V7.7z"/><path d="M3.5 7.7L12 12.6l8.5-4.9M12 12.6v8.6"/>',
  board: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M8 7.5v7M12 7.5v4M16 7.5v9"/>',
  meeting: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 4.8a3.2 3.2 0 0 1 0 6.4M18 14.2a6 6 0 0 1 3 5.8"/>',
  chart: '<path d="M3.5 3.5v17h17"/><path d="M8 16.5v-5M12.5 16.5v-9M17 16.5v-3"/>',
};

/** SVG markup for an icon. Unknown names render nothing. */
export function icon(name, { size = 16, label = "", cls = "" } = {}) {
  const body = ICONS[name];
  if (!body) return "";
  const s = Number(size) || 16;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`;
  return `<svg class="ao-icon${cls ? " " + esc(cls) : ""}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`;
}
