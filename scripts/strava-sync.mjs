// Auto-syncs recent Strava activities into training.json by matching activity
// date to training day date. Runs on a schedule via .github/workflows/strava-sync.yml
// so the training log fills in even when nobody opens admin.html.
import fs from 'fs';

// Same app credentials already public in index.html — not secret on their own.
const CLIENT_ID = '252608';
const CLIENT_SECRET = '1807ba66a14418a1255ec114bcfaebda8a4440b6';
const REFRESH_TOKEN = process.env.STRAVA_REFRESH_TOKEN;

if (!REFRESH_TOKEN) {
  console.log('No STRAVA_REFRESH_TOKEN secret configured — skipping sync.');
  process.exit(0);
}

async function getAccessToken() {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Strava auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

function toMiles(m) { return Math.round((m / 1609.344) * 100) / 100; }
function toFeet(m) { return Math.round(m * 3.28084); }

function activityToObj(a) {
  const miles = toMiles(a.distance || 0);
  const movingSec = a.moving_time || 0;
  let pace = '';
  if (miles > 0 && movingSec > 0) {
    const paceSecPerMi = movingSec / miles;
    const mm = Math.floor(paceSecPerMi / 60);
    const ss = Math.round(paceSecPerMi % 60);
    pace = `${mm}:${String(ss).padStart(2, '0')}/mi`;
  }
  return {
    id: a.id,
    name: a.name,
    type: a.type || a.sport_type || 'Activity',
    distanceMiles: miles,
    movingTimeSec: movingSec,
    elapsedTimeSec: a.elapsed_time || 0,
    elevGainFt: toFeet(a.total_elevation_gain || 0),
    pace,
    url: `https://www.strava.com/activities/${a.id}`,
    startDateLocal: a.start_date_local,
  };
}

async function fetchActivities(token, afterEpochSec) {
  let page = 1;
  let all = [];
  while (true) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterEpochSec}&per_page=100&page=${page}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100 || page > 5) break;
    page++;
  }
  return all;
}

async function main() {
  const days = JSON.parse(fs.readFileSync('training.json', 'utf8'));
  const todayStr = new Date().toISOString().split('T')[0];
  const pending = days.filter(
    (d) => d.date <= todayStr && (!d.stravaActivities || d.stravaActivities.length === 0)
  );

  if (pending.length === 0) {
    console.log('Nothing pending — every logged day already has Strava data.');
    return;
  }

  const minDate = pending.reduce((m, d) => (d.date < m ? d.date : m), pending[0].date);
  const afterEpoch = Math.floor(new Date(minDate + 'T00:00:00Z').getTime() / 1000) - 86400;

  const token = await getAccessToken();
  const activities = await fetchActivities(token, afterEpoch);

  const byDate = {};
  activities.forEach((a) => {
    const d = (a.start_date_local || '').slice(0, 10);
    if (!d) return;
    (byDate[d] = byDate[d] || []).push(activityToObj(a));
  });

  let matched = 0;
  const updated = days.map((day) => {
    if (byDate[day.date] && byDate[day.date].length && (!day.stravaActivities || day.stravaActivities.length === 0)) {
      matched++;
      return { ...day, stravaActivities: byDate[day.date], completed: true };
    }
    return day;
  });

  if (matched > 0) {
    fs.writeFileSync('training.json', JSON.stringify(updated, null, 2) + '\n');
    console.log(`Linked Strava activities for ${matched} day(s).`);
  } else {
    console.log('No new matches found for pending days.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
