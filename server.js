// Miroir de http://192.168.4.1/ : toutes les pages de l'ESP32-CAM sont
// relayees par ce serveur (l'ESP32 appelle Render, jamais l'inverse).
const express = require('express');
const app = express();

const KEY = process.env.KEY || '1234';

let queue = [];      // requetes navigateur en attente {id, method, path, body}
let pollers = [];    // appels longs de l'ESP32 en attente
let waiting = {};    // id -> {resolve, timer}
let nextId = 1;
const cache = new Map();   // images deja recuperees (path -> reponse)

function authEsp(req, res, next) {
  if (req.query.k !== KEY) return res.status(401).send('Cle invalide');
  next();
}

function dispatch() {
  while (queue.length && pollers.length) {
    const p = pollers.shift();
    clearTimeout(p.timer);
    const c = queue.shift();
    p.res.send(`${c.id}\n${c.method}\n${c.path}\n${c.body}`);
  }
}

function ask(method, path, body) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => {
      delete waiting[id];
      queue = queue.filter(q => q.id !== id);
      reject(new Error('timeout'));
    }, 40000);
    waiting[id] = { resolve, timer };
    queue.push({ id, method, path, body });
    dispatch();
  });
}

/* ---------- Cote ESP32 ---------- */
// L'ESP32 attend ici (appel long) qu'une page soit demandee
app.get('/esp/poll', authEsp, (req, res) => {
  const p = { res };
  p.timer = setTimeout(() => {
    pollers = pollers.filter(x => x !== p);
    res.send('none');
  }, 20000);
  req.on('close', () => {
    clearTimeout(p.timer);
    pollers = pollers.filter(x => x !== p);
  });
  pollers.push(p);
  dispatch();
});

// L'ESP32 renvoie ici la reponse de sa propre page
app.post('/esp/result', authEsp, express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
  const w = waiting[req.query.id];
  if (w) {
    clearTimeout(w.timer);
    delete waiting[req.query.id];
    w.resolve({
      status: parseInt(req.get('X-Status')) || 502,
      ctype: req.get('X-Ctype') || 'application/octet-stream',
      loc: req.get('X-Location') || '',
      disp: req.get('X-Disp') || '',
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    });
  }
  res.send('ok');
});

/* ---------- Cote navigateur : miroir de l'ESP32 ---------- */
app.use(express.raw({ type: '*/*', limit: '1mb' }));

app.use(async (req, res) => {
  // Mot de passe : /?k=1234 la premiere fois, ensuite cookie
  if (req.query.k === KEY) {
    res.set('Set-Cookie', `k=${KEY}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
    const u = new URL(req.originalUrl, 'http://x');
    u.searchParams.delete('k');
    return res.redirect(u.pathname + u.search);
  }
  const m = /(?:^|;\s*)k=([^;]*)/.exec(req.headers.cookie || '');
  if (!m || m[1] !== KEY) {
    return res.status(401).send('Acces refuse. Ouvrez /?k=VOTRE_CLE une premiere fois.');
  }

  if (req.path === '/favicon.ico') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const isImg = req.method === 'GET' && /\.jpe?g$/i.test(req.path);
  if (req.path.startsWith('/delete')) cache.clear();
  if (isImg && cache.has(req.path)) {
    const c = cache.get(req.path);
    return res.status(c.status).type(c.ctype).send(c.body);
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString() : '';
  let r;
  try {
    r = await ask(req.method, req.originalUrl, body);
  } catch (e) {
    return res.status(504).send('ESP32 hors ligne ou ne repond pas. Reessayez.');
  }

  if (r.loc) res.set('Location', r.loc);
  if (r.disp) res.set('Content-Disposition', r.disp);
  res.status(r.status);

  if (/text\/html/i.test(r.ctype)) {
    // charge les photos seulement quand on les voit
    return res.type('html').send(r.body.toString('utf8').replace(/<img /g, '<img loading="lazy" '));
  }
  if (isImg && r.status === 200) {
    if (cache.size > 300) cache.clear();
    cache.set(req.path, { status: r.status, ctype: r.ctype, body: r.body });
  }
  res.type(r.ctype).send(r.body);
});

app.listen(process.env.PORT || 3000, () => console.log('Serveur demarre'));
