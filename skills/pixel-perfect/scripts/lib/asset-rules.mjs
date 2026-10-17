// Pure rules for assets.mjs: font licenses, script categories, kinds and file names.
// No I/O here, so every rule can be tested without a browser.

const OPEN_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.bunny.net']);
const ADOBE_HOSTS = new Set(['use.typekit.net', 'p.typekit.net']);
const COMMERCIAL_HOSTS = new Set([
  'fast.fonts.net',
  'cloud.typography.com',
  'cloud.webtype.com',
  'pro.fontawesome.com',
  'ka-p.fontawesome.com',
]);
const WEBFLOW_HOSTS = new Set(['assets.website-files.com', 'cdn.prod.website-files.com', 'uploads-ssl.webflow.com']);

// Checked in order. A keyword matches a host label at its start: "segment" matches "cdn.segment.com".
const SCRIPT_TABLE = [
  [
    'analytics',
    [
      'googletagmanager',
      'google-analytics',
      'segment',
      'plausible',
      'posthog',
      'mixpanel',
      'hotjar',
      'clarity.ms',
      'amplitude',
      'heap',
      'fullstory',
      'cloudflareinsights',
      'va.vercel-scripts',
    ],
  ],
  ['chat', ['intercom', 'crisp', 'drift', 'tawk.to', 'zdassets', 'zendesk', 'usemessages', 'hubspot', 'livechatinc']],
  [
    'ads',
    [
      'doubleclick',
      'googlesyndication',
      'connect.facebook.net',
      'ads-twitter',
      'snap.licdn.com',
      'bat.bing.com',
      'redditstatic',
      'analytics.tiktok',
    ],
  ],
  ['forms', ['hsforms', 'typeform', 'jotform', 'tally.so', 'formspree']],
  ['video', ['youtube', 'ytimg', 'vimeo', 'wistia', 'loom']],
];

const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'svg']);

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'application/x-font-opentype': 'otf',
  'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
};

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function mimeOf(contentType) {
  return String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

// Lowercase file extension of the URL path, or '' when there is none.
function urlExt(url) {
  const u = parseUrl(url);
  if (!u) return '';
  const match = /\.([a-z0-9]{1,5})$/i.exec(u.pathname);
  return match ? match[1].toLowerCase() : '';
}

function isFontType(ct) {
  return ct.startsWith('font/') || ct.includes('font') || ct.includes('opentype');
}

// Registrable domain: "cdn.example.co.uk" -> "example.co.uk". IPs and single labels come back unchanged.
export function registrableDomain(host) {
  const h = String(host ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h)) return h;
  const labels = h.split('.');
  const n = labels.length;
  if (n >= 3 && SECOND_LEVEL_LABELS.has(labels[n - 2]) && labels[n - 1].length === 2) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

// Returns { class, status, flag, note } for the font host of url. Non-font callers ignore the result.
export function fontLicense(url, pageUrl) {
  const u = parseUrl(url);
  const host = u ? u.hostname.toLowerCase() : '';
  const path = u ? u.pathname : '';
  if (ADOBE_HOSTS.has(host)) {
    return {
      class: 'adobe-kit',
      status: 'remote',
      flag: true,
      note: 'Adobe Fonts kit: kept as a remote link. Add the new domain to the kit.',
    };
  }
  if (COMMERCIAL_HOSTS.has(host)) {
    return {
      class: 'commercial',
      status: 'skipped',
      flag: true,
      note: 'Commercial font: not downloaded. A license is needed for the new domain.',
    };
  }
  if (OPEN_FONT_HOSTS.has(host) || ((host === 'cdn.jsdelivr.net' || host === 'unpkg.com') && /\/@fontsource\//.test(path))) {
    return { class: 'open', status: 'saved', flag: false, note: 'Open font license.' };
  }
  const page = parseUrl(pageUrl);
  const sameSite = page && registrableDomain(page.hostname) === registrableDomain(host);
  const ownerCdn =
    WEBFLOW_HOSTS.has(host) ||
    host === 'framerusercontent.com' ||
    host.endsWith('.framerusercontent.com') ||
    path.includes('/wp-content/');
  if (sameSite || ownerCdn) {
    return {
      class: 'owner-uploaded',
      status: 'saved',
      flag: true,
      note: 'Owner-uploaded font. Confirm the license covers the new site.',
    };
  }
  return { class: 'unknown', status: 'saved', flag: true, note: 'Font from an unknown host. Check its license.' };
}

// Category for a third-party script host: analytics, chat, ads, forms, video or other.
export function scriptCategory(host) {
  const h = String(host ?? '').toLowerCase();
  for (const [category, keywords] of SCRIPT_TABLE) {
    for (const keyword of keywords) {
      const pattern = new RegExp(`(^|[.-])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (pattern.test(h)) return category;
    }
  }
  return 'other';
}

// Kind of an asset: icon, font, svg, video, img or misc.
export function kindFor({ url, contentType, resourceType, source } = {}) {
  if (source === 'icon') return 'icon';
  const ct = mimeOf(contentType);
  const ext = urlExt(url);
  if (isFontType(ct) || resourceType === 'font' || FONT_EXT.has(ext)) return 'font';
  if (ct === 'image/svg+xml' || (!ct.startsWith('image/') && ext === 'svg')) return 'svg';
  if (ct.startsWith('video/') || (!ct.startsWith('image/') && VIDEO_EXT.has(ext))) return 'video';
  if (ct.startsWith('image/') || IMAGE_EXT.has(ext)) return 'img';
  return 'misc';
}

// File extension (no dot): the content type wins, then the URL extension, then "bin".
export function extFor(url, contentType) {
  const byType = EXT_BY_TYPE[mimeOf(contentType)];
  if (byType) return byType;
  const ext = urlExt(url);
  if (ext === 'jpeg') return 'jpg';
  return ext || 'bin';
}

// "https://x.com/img/Hero Shot.png" + image/png + sha256 -> "hero-shot-1a2b3c4d.png"
export function fileNameFor(url, contentType, sha256) {
  const u = parseUrl(url);
  let base = u ? u.pathname.split('/').pop() : '';
  try {
    base = decodeURIComponent(base);
  } catch {}
  const slug =
    base
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'file';
  return `${slug}-${String(sha256).slice(0, 8)}.${extFor(url, contentType)}`;
}

// URL prefix for the out folder. "public/assets" -> "/assets"; "assets/x" stays "assets/x".
export function publicBaseFor(out) {
  const parts = String(out ?? '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.');
  const at = parts.lastIndexOf('public');
  if (at >= 0 && at < parts.length - 1) return `/${parts.slice(at + 1).join('/')}`;
  if (at >= 0 && at === parts.length - 1) return '/';
  return parts.join('/');
}
