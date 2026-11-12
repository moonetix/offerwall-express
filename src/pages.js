import { formatMicro } from './moonetix.js';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const STYLE = `
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1f2b; background: #f6f7fb; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 64px; padding: 0 16px; background: #fff; border-bottom: 1px solid #e3e6ee; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; margin: 8px 0; }
  .card { background: #fff; border: 1px solid #e3e6ee; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .balance { font-weight: 600; }
  .muted { color: #4a5263; font-size: .9rem; }
  .error { color: #b42318; }
  button { font: inherit; padding: 8px 14px; border: 0; border-radius: 6px; background: #004abb; color: #fff; cursor: pointer; }
  button.link { background: none; color: #004abb; padding: 0; }
  input[type=text], input[type=password] { font: inherit; padding: 8px; width: 100%; max-width: 320px; box-sizing: border-box; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e6ee; }`;

function layout(title, body, user) {
  const nav = user
    ? `<form method="post" action="/logout"><span class="balance">${esc(formatMicro(user.balance_micro))} coins</span> <button type="submit" class="link">Sign out</button></form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Offerwall Express</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>Offerwall Express</strong>${nav}</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function loginPage({ error = false, username = '' } = {}) {
  return layout('Sign in', `<h1>Sign in</h1>
<p class="muted">Demo sign-in. Create a user with <code>npm run create-user -- NAME</code>.</p>
<form method="post" action="/login" class="card">
<p><label>Username<br><input type="text" name="username" value="${esc(username)}" required autofocus></label></p>
<p><label>Password<br><input type="password" name="password" required></label></p>
${error ? '<p class="error">Your username and password did not match.</p>' : ''}
<button type="submit">Sign in</button>
</form>`);
}

export function earnPage({ user, wallUrl, recent, ageError = false }) {
  const wall = wallUrl
    ? `<iframe title="Earn coins" src="${esc(wallUrl)}" style="border:0;width:100%;height:calc(100vh - 64px)"></iframe>
<p class="muted">Follow your offers in My offers at the top of the offerwall. Report a missing reward there.</p>`
    : `<form method="post" action="/earn/age" class="card">
<p>Offers are only for users who are 16 or older. Users under 18 need a parent's permission.</p>
<p><label><input type="checkbox" name="age_16_or_older" value="1" required> I am 16 or older</label></p>
${ageError ? '<p class="error">Please confirm your age to continue.</p>' : ''}
<button type="submit">Continue</button>
</form>`;
  const rows = recent.map((r) => `<tr><td>${esc(String(r.created_at).slice(0, 10))}</td><td>${esc(r.offer_name || 'Offer')}</td><td>${esc(formatMicro(r.reward_micro))}</td><td>${r.status === 1 ? 'Credited' : 'Reversed'}</td></tr>`).join('\n');
  const table = recent.length
    ? `<table><thead><tr><th>Date</th><th>Offer</th><th>Coins</th><th>Status</th></tr></thead><tbody>
${rows}
</tbody></table>`
    : '<p class="muted">No rewards yet.</p>';
  return layout('Earn coins', `<h1>Earn coins</h1>
<p class="muted">Complete offers from our partners to earn coins. Most rewards arrive within minutes of the advertiser confirming the offer. A reward can be taken back if the advertiser reverses it.</p>
${wall}
<section class="card">
<h2>Recent rewards</h2>
${table}
</section>`, user);
}
