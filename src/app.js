import express from 'express';
import { clearCookie, sessionCookie, sessionUserId, verifyPassword } from './auth.js';
import { handlePostback, readParams, wallUrl } from './moonetix.js';
import { earnPage, loginPage } from './pages.js';

export function createApp({ config, store, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');

  // Registered before any session or body handling: Moonetix calls this server to
  // server, without cookies, and the hash is the only thing that authenticates it.
  app.get('/moonetix/postback', (req, res) => {
    // Express 5 parses ?tx=a&tx=b into an array; readParams turns that into a 403.
    const params = readParams((key) => req.query[key]);
    let out;
    try {
      out = handlePostback(params, { postbackKey: config.postbackKey, store, log });
    } catch (err) {
      // Nothing was committed. 500 makes Moonetix retry later.
      log('postback failed', { error: err.message });
      out = { code: 500, body: 'Error' };
    }
    res.status(out.code).type('text/plain').set('Cache-Control', 'no-store').send(out.body);
  });
  app.all('/moonetix/postback', (req, res) => {
    res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('Method not allowed');
  });

  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.use((req, res, next) => {
    const id = sessionUserId(config.sessionSecret, req.headers.cookie);
    req.user = id ? store.findUserById(id) : null;
    next();
  });

  // Forms only accept same-origin posts. SameSite=Lax cookies cover most of this already.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (req.method === 'POST' && origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed Origin */ }
      if (host !== req.get('host')) return res.status(403).type('text/plain').send('Cross-site request blocked');
    }
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : res.redirect(303, '/login'));
  const html = (res, body, code = 200) => res.status(code).type('html').set('Cache-Control', 'private, no-store').send(body);

  app.get('/', (req, res) => res.redirect(303, '/earn'));

  app.get('/login', (req, res) => html(res, loginPage()));

  app.post('/login', (req, res) => {
    const username = String(req.body?.username ?? '');
    const user = store.findUserByName(username);
    if (!user || !verifyPassword(String(req.body?.password ?? ''), user.password_hash)) {
      return html(res, loginPage({ error: true, username }), 401);
    }
    res.set('Set-Cookie', sessionCookie(config.sessionSecret, user.id, config.secureCookies));
    res.redirect(303, '/earn');
  });

  app.post('/logout', (req, res) => {
    res.set('Set-Cookie', clearCookie(config.secureCookies));
    res.redirect(303, '/login');
  });

  // The link is signed here, for the signed-in user only. Query parameters are never used for it.
  app.get('/earn', requireUser, (req, res) => {
    const link = req.user.age_confirmed_at ? wallUrl(config, req.user.id) : null;
    html(res, earnPage({ user: req.user, wallUrl: link, recent: store.recent(req.user.id) }));
  });

  app.post('/earn/age', requireUser, (req, res) => {
    if (req.body?.age_16_or_older !== '1') {
      return html(res, earnPage({ user: req.user, wallUrl: null, recent: [], ageError: true }), 400);
    }
    store.confirmAge(req.user.id);
    res.redirect(303, '/earn');
  });

  // For a single-page front end: fetch the signed link with the session cookie.
  app.get('/api/offerwall-link', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!req.user.age_confirmed_at) return res.status(403).json({ error: 'Age not confirmed' });
    res.json({ url: wallUrl(config, req.user.id) });
  });

  return app;
}
