// The Admin page: counts across every household, how full each one's data is, the summary email
// job's recent emails, and checks that flag anything going wrong. The numbers come from
// admin/stats and admin/runs, which the summary email job writes about once an hour
// (sync/admin_report.py). Only the site's admins can read them (firestore.rules), so for anyone
// else isAdmin() is false and the page never shows.
import { firebase } from './firebase.js';

const HOUR = 36e5;

// True when the signed-in person is one of the site's admins (listed in admin/access).
export async function isAdmin() {
  const { fs, db } = await firebase();
  try {
    return (await fs.getDoc(fs.doc(db, 'admin/access'))).exists();
  } catch {
    return false; // not an admin, or the rules that allow it aren't published yet
  }
}

// { stats, runs } from the job's last report; either can be null before its first report.
export async function loadAdmin() {
  const { fs, db } = await firebase();
  const [s, r] = await Promise.all([fs.getDoc(fs.doc(db, 'admin/stats')), fs.getDoc(fs.doc(db, 'admin/runs'))]);
  return { stats: s.exists() ? s.data() : null, runs: r.exists() ? r.data().list || [] : [] };
}

export const shortId = (id) => String(id || '').slice(0, 6);
export function fmtBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n || 0} B`;
}
const hoursSince = (iso, now) => (now - Date.parse(iso)) / HOUR;
const agoText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);

// The checks at the top of the Admin page: [{ id, level: ok | warn | bad, title, text }].
// `site` describes this screen: { feedback, fitbit } (whether those are set up for the site).
export function monitors({ stats, runs = [], now = Date.now(), site = {} }) {
  const out = [];
  const add = (id, level, title, text) => out.push({ id, level, title, text });

  if (!stats) {
    add('job', 'bad', 'Admin stats', 'No report yet. The Daily summary email job writes one each hour once FIREBASE_SERVICE_ACCOUNT and ADMIN_EMAILS are set.');
    return out;
  }
  const age = hoursSince(stats.at, now);
  add('job', age > 12 ? 'bad' : age > 3 ? 'warn' : 'ok', 'Hourly job',
    age > 3 ? `Last report ${agoText(age)}. GitHub may be starting the job late, or it is failing; check its runs in Actions.` : `Reported ${agoText(age)}.`);

  const day = runs.filter((r) => hoursSince(r.at, now) <= 24);
  const failed = day.filter((r) => !r.ok);
  const on = (stats.homes || []).filter((h) => h.email);
  // emailSent is "YYYY-MM-DD-slot" on the household's clock; two days back allows for any time zone.
  const twoDays = new Date(now - 2 * 24 * HOUR).toISOString().slice(0, 10);
  const quiet = on.filter((h) => !h.emailSent || h.emailSent.slice(0, 10) < twoDays);
  if (!stats.secrets?.smtp) add('email', on.length ? 'bad' : 'warn', 'Summary email', 'The sending account isn\'t set up: add EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD.');
  else if (failed.length) add('email', 'bad', 'Summary email', `${failed.length} of ${day.length} emails failed in the last day. Latest: ${failed[0].error || 'no reason given'}`);
  else if (quiet.length) add('email', 'warn', 'Summary email', `${quiet.length} household${quiet.length === 1 ? ' has' : 's have'} the email on but got none in two days.`);
  else add('email', 'ok', 'Summary email', on.length ? `${day.length} sent in the last day, none failed. ${on.length} household${on.length === 1 ? '' : 's'} get it.` : 'No household has turned it on yet.');

  const limit = stats.limit || 1040000;
  const big = (stats.homes || [])[0];
  const fill = big ? big.size / limit : 0;
  const near = (stats.homes || []).filter((h) => h.size / limit >= 0.8).length;
  add('size', fill >= 0.9 ? 'bad' : fill >= 0.8 ? 'warn' : 'ok', 'Household data size',
    big ? `${near ? `${near} household${near === 1 ? ' is' : 's are'} over 80% full. ` : ''}The largest uses ${Math.round(fill * 100)}% (${fmtBytes(big.size)} of ${fmtBytes(limit)}).` : 'No household has synced yet.');

  if (stats.legacyActive) add('legacy', 'warn', 'Passphrase households', `${stats.legacyActive} old passphrase household${stats.legacyActive === 1 ? ' was' : 's were'} used in the last 30 days. Their database rule lets anyone with the id write, so move them to sign-in.`);
  else add('legacy', 'ok', 'Passphrase households', stats.legacy ? `${stats.legacy} left, none used in 30 days. The households rule can be removed.` : 'None left.');

  const missing = [!site.feedback && 'FEEDBACK_EMAIL (Feedback has no address)', !site.fitbit && 'GOOGLE_HEALTH_CLIENT_ID (no Fitbit sign-in)'].filter(Boolean);
  add('config', missing.length ? 'warn' : 'ok', 'Site settings', missing.length ? `Not set: ${missing.join('; ')}.` : 'Feedback address and Fitbit sign-in are set up.');
  return out;
}

// The worst level among the checks, for the dot on Settings' Admin row.
export const worst = (list) => (list.some((m) => m.level === 'bad') ? 'bad' : list.some((m) => m.level === 'warn') ? 'warn' : 'ok');
