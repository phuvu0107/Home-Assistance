// Phone alerts for a new thank-you or a ticked-off bucket list item, sent through ntfy
// (https://ntfy.sh), a free notification service with apps for iPhone and Android.
//
// The app is a static site with no server of its own, so the device that sends a thank-you also
// sends the alert: one small request to ntfy, straight from the browser. Each person who turns
// alerts on gets their own private channel ("topic"): a random name kept on their member record
// (member.alerts), which syncs only within the household, so nobody outside it can find it. This
// works the same for signed-in and passphrase households. An alert only says who did what, never
// the note's words, since it passes through ntfy's servers unencrypted.
//
// Kept free of the page so it can be tested on its own (tests/alerts.test.mjs).

export const NTFY = 'https://ntfy.sh';
const TOPIC = /^home-[0-9a-f]{24}$/;

// A new private channel name, e.g. "home-3f9a…" (96 random bits).
export const newAlertTopic = () => `home-${[...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
export const alertTopicOf = (u) => (TOPIC.test(u?.alerts || '') ? u.alerts : '');

// Who should hear about something done by `from`: everyone else who turned alerts on.
export const alertRecipients = (members, from) => (members || []).filter((u) => alertTopicOf(u) && u.id !== from);

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
export async function sendAlerts(recipients, alert, { click, fetchFn = globalThis.fetch } = {}) {
  const sent = await Promise.all(recipients.filter(alertTopicOf).map(async (u) => {
    try {
      const r = await fetchFn(`${NTFY}/`, { method: 'POST', keepalive: true, body: JSON.stringify({ topic: u.alerts, ...alert, ...(click && { click }) }) });
      return r.ok ? 1 : 0;
    } catch { return 0; }
  }));
  return sent.reduce((a, b) => a + b, 0);
}
