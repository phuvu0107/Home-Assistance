// Phone alerts for a new thank-you or a ticked-off bucket list item, sent through ntfy
// (https://ntfy.sh), a free notification service with apps for iPhone and Android.
//
// The app is a static site with no server of its own, so the device that sends a thank-you also
// sends the alert: one small request to ntfy, straight from the browser. Each person has their own
// private channel ("topic") made from the household passphrase and their id, so only someone who
// knows the passphrase can find it, and it changes if the passphrase does. An alert only says who
// did what, never the note's words, since it passes through ntfy's servers unencrypted.
//
// A person turns alerts on for themselves in Settings (member.alerts, synced with the household),
// and only people who did get anything sent. Kept free of the page so it can be tested on its own
// (tests/alerts.test.mjs).

export const NTFY = 'https://ntfy.sh';

// The person's channel name, e.g. "home-3f9a…": the same on every device with the passphrase.
export async function alertTopic(pass, id) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`home-dashboard alerts:${pass}:${id}`));
  return `home-${[...new Uint8Array(h)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// Who should hear about something done by `from`: everyone else who turned alerts on.
export const alertRecipients = (members, from) => (members || []).filter((u) => u.alerts && u.id !== from);

// What the alert says. `name` is the sender's name, already cleaned for the page.
export function thanksAlert(name, emoji) {
  return { title: `${name} sent you a thank-you ${emoji || '💌'}`, message: 'Open Home to read it.', tags: ['love_letter'] };
}
export function bucketAlert(name, love) {
  return { title: `${name} ticked off a bucket list item 🎉`, message: `+${love} love points. Open Home to see which one.`, tags: ['tada'] };
}
export const testAlert = () => ({ title: 'Home alerts are on ✅', message: 'Thank-yous and bucket list ticks will show up here.', tags: ['white_check_mark'] });

// Send one alert to each recipient. Never throws: an alert that can't go out (offline, ntfy
// down) is skipped, and the thank-you itself still syncs as usual. The JSON goes to ntfy's root
// with no custom headers, so the browser sends it as a simple request with no CORS preflight.
export async function sendAlerts(pass, recipients, alert, { click, fetchFn = globalThis.fetch } = {}) {
  if (!pass || !recipients.length) return 0;
  const sent = await Promise.all(recipients.map(async (u) => {
    try {
      const topic = await alertTopic(pass, u.id);
      const r = await fetchFn(`${NTFY}/`, { method: 'POST', keepalive: true, body: JSON.stringify({ topic, ...alert, ...(click && { click }) }) });
      return r.ok ? 1 : 0;
    } catch { return 0; }
  }));
  return sent.reduce((a, b) => a + b, 0);
}
