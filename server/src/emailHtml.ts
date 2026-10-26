import { config } from './config.js';

// Branded HTML layout in ATS Group's identity (https://www.atsgroup.world): navy, gold, blue-cyan accent.
// Email clients (Gmail, Outlook) ignore most <style> rules, so everything is inline and table-based.
// Gradients have a solid background-color fallback for clients that drop background-image.

const C = {
  navy: '#0b1428',
  navyDeep: '#060a13',
  gold: '#f5b942',
  goldDark: '#c98a14',
  blue: '#3b82f6',
  cyan: '#22d3ee',
  page: '#eef1f6',
  text: '#1f2937',
  heading: '#0f172a',
  muted: '#64748b',
  line: '#e5e9f0',
  soft: '#f7f8fb',
  onNavy: '#cbd5e1',
  onNavyMuted: '#8b97ab',
};

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]]/g;
const SIGN_OFF_RE = /^(best( regards)?|kind regards|warm regards|regards|sincerely|thanks|thank you|cheers|best wishes)\b[,!.]?$/i;

const PILLARS = [
  { letter: 'A', word: 'Alliance', line: 'Long-term partnership' },
  { letter: 'T', word: 'Technology', line: 'Engineering & applied AI' },
  { letter: 'S', word: 'Success', line: 'Results we share' },
];
const SERVICES = 'Full-Stack Development · AI Automation · CMS Solutions · CRM Solutions';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Escapes plain text and turns its URLs into links. URLs are found in the raw text, before escaping, so a URL
 * next to a quote or containing "&" isn't cut at an "&quot;" / "&amp;" entity.
 */
function linkify(text: string): string {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    html += esc(text.slice(last, match.index));
    html += `<a href="${esc(url)}" style="color:${C.blue};text-decoration:underline;">${esc(url)}</a>`;
    last = match.index + url.length;
  }
  return html + esc(text.slice(last));
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split(/[/?#]/)[0]; // malformed URL: don't fail the whole email
  }
}

function button(url: string): string {
  const label = /#contact\b/i.test(url) ? 'Contact ATS Group' : `Visit ${hostname(url)}`;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
      <tr><td bgcolor="${C.gold}" style="border-radius:8px;background-color:${C.gold};background-image:linear-gradient(180deg,#ffd27a,${C.gold});">
        <a href="${esc(url)}" style="${FONT}display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;letter-spacing:.2px;color:${C.navy};text-decoration:none;border-radius:8px;">${esc(label)} &rarr;</a>
      </td></tr>
    </table>`;
}

/** "Best regards,\nAkira Iwata\nSoftware Engineer | Japan" -> sign-off, then a signature block with the logo. */
function signature(paragraph: string): string {
  const [signOff, rawName, ...rest] = paragraph.split('\n').map((l) => l.trim());
  const name = rawName ? esc(rawName) : '';
  const { logoUrl, name: brand } = config.brand;
  return `
    <p style="margin:28px 0 14px;">${esc(signOff)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};">
      <tr>
        ${logoUrl ? `<td valign="top" style="padding:16px 14px 0 0;"><img src="${esc(logoUrl)}" width="44" height="44" alt="${esc(brand)}" style="display:block;border-radius:10px;border:0;"></td>` : ''}
        <td valign="top" width="100%" style="${FONT}padding-top:16px;">
          ${name ? `<div style="font-size:15px;font-weight:700;color:${C.heading};">${name}</div>` : ''}
          ${rest.map((l) => `<div style="font-size:13px;color:${C.muted};margin-top:2px;">${linkify(l)}</div>`).join('')}
          <div style="font-size:13px;margin-top:4px;"><span style="color:${C.goldDark};font-weight:700;">${esc(brand)}</span><span style="color:${C.muted};"> &middot; ${esc(config.brand.location)}</span></div>
        </td>
      </tr>
    </table>`;
}

function renderBody(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^https?:\/\/\S+$/.test(p)) return button(p);
      // A sign-off needs a name under it; a lone "Thank you." mid-email is just a paragraph.
      if (SIGN_OFF_RE.test(p.split('\n')[0].trim()) && p.includes('\n')) return signature(p);
      return `<p style="margin:0 0 16px;">${p
        .split('\n')
        .map((l) => linkify(l.trim()))
        .join('<br>')}</p>`;
    })
    .join('\n');
}

/** Hidden inbox-preview text: the first real sentence after the greeting. */
function preheader(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  const first = paragraphs.find((p, i) => !(i === 0 && /^(hi|hello|dear|hey)\b/i.test(p) && p.length < 40)) ?? '';
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

function header(): string {
  const { name, url, logoUrl, location } = config.brand;
  return `
      <tr><td bgcolor="${C.navy}" style="background-color:${C.navy};background-image:linear-gradient(135deg,#14233f 0%,${C.navyDeep} 100%);padding:26px 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td valign="middle">
              <a href="${esc(url)}" style="text-decoration:none;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  ${logoUrl ? `<td valign="middle" style="padding-right:14px;"><img src="${esc(logoUrl)}" width="48" height="48" alt="${esc(name)} logo" style="display:block;border-radius:12px;border:1px solid #3a3320;"></td>` : ''}
                  <td valign="middle" style="${FONT}">
                    <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.3px;">${esc(name)}</div>
                    <div style="font-size:12px;color:${C.onNavy};margin-top:3px;">${esc(config.brand.tagline)}</div>
                  </td>
                </tr></table>
              </a>
            </td>
            <td valign="middle" align="right" style="${FONT}font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.onNavyMuted};white-space:nowrap;">${esc(location)}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td bgcolor="${C.blue}" style="height:3px;line-height:3px;font-size:0;background-color:${C.blue};background-image:linear-gradient(90deg,${C.blue},${C.cyan} 60%,${C.gold});">&nbsp;</td></tr>`;
}

function pillars(): string {
  const cells = PILLARS.map(
    (p) => `
          <td width="33%" valign="top" style="${FONT}padding:18px 10px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:${C.goldDark};line-height:1;">${p.letter}</div>
            <div style="font-size:13px;font-weight:700;color:${C.heading};margin-top:6px;">${p.word}</div>
            <div style="font-size:12px;color:${C.muted};margin-top:2px;">${p.line}</div>
          </td>`,
  ).join('');
  return `
      <tr><td style="padding:0 36px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.soft}" style="background-color:${C.soft};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
          <tr>${cells}
          </tr>
        </table>
      </td></tr>`;
}

function footer(): string {
  const { name, url, location, established } = config.brand;
  const site = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const contact = `${url.replace(/\/$/, '')}/#contact`;
  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" style="color:${C.gold};text-decoration:none;font-weight:600;">${label}</a>`;
  const unsubscribe = config.unsubscribeMailto
    ? `<br>You are receiving this email from ${esc(name)}. If you'd rather not hear from us,
       <a href="${esc(config.unsubscribeMailto)}?subject=unsubscribe" style="color:${C.onNavy};text-decoration:underline;">unsubscribe here</a>.`
    : '';
  return `
      <tr><td bgcolor="${C.navy}" style="${FONT}background-color:${C.navy};padding:26px 36px 28px;color:${C.onNavy};font-size:12px;line-height:1.7;">
        <div style="font-size:14px;font-weight:700;color:#ffffff;">${esc(name)}</div>
        <div style="color:${C.onNavy};">Software engineering, AI automation &amp; partnership, built in ${esc(location.split(',')[0])}.</div>
        <div style="color:${C.onNavyMuted};margin-top:8px;">${esc(SERVICES)}</div>
        <div style="margin-top:12px;">${link(url, esc(site))} &nbsp;&middot;&nbsp; ${link(contact, 'Contact us')}</div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid #1e2a44;color:${C.onNavyMuted};font-size:11px;">
          ${esc(location)}${established ? ` &middot; Est. ${esc(established)}` : ''} &middot; &copy; ${new Date().getFullYear()} ${esc(name)}. All rights reserved.${unsubscribe}
        </div>
      </td></tr>`;
}

/** Branded HTML version of a plain-text email. The plain text is still sent alongside it. */
export function emailHtml(subject: string, text: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader(text))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" style="background-color:${C.page};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:14px;border-collapse:separate;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.06);">
      ${header()}
      <tr><td style="${FONT}padding:34px 36px 12px;font-size:15px;line-height:1.7;color:${C.text};">
        ${renderBody(text)}
      </td></tr>
      ${pillars()}
      ${footer()}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
