const express = require('express');
const app = express();

const KEY = process.env.KEY || '1234';   // mot de passe (a changer dans Render > Environment)
let queue = [];        // commandes en attente pour l'ESP32
let waiting = {};      // id -> {resolve, timer}
let nextId = 1;
let lastSeen = 0;      // derniere fois que l'ESP32 a appele

function auth(req, res, next) {
  if (req.query.k !== KEY) return res.status(401).send('Cle invalide');
  next();
}

// Envoie une commande a l'ESP32 et attend sa reponse
function ask(cmd, file) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => {
      delete waiting[id];
      queue = queue.filter(q => q.id !== id);
      reject(new Error('ESP32 ne repond pas'));
    }, 40000);
    waiting[id] = { resolve, timer };
    queue.push({ id, cmd, file: file || '' });
  });
}
function done(id, data) {
  const w = waiting[id];
  if (!w) return false;
  clearTimeout(w.timer);
  delete waiting[id];
  w.resolve(data);
  return true;
}

/* ---------- Cote ESP32 ---------- */
app.get('/esp/poll', auth, (req, res) => {
  lastSeen = Date.now();
  const c = queue.shift();
  res.send(c ? `${c.id}|${c.cmd}|${c.file}` : 'none');
});
app.post('/esp/result', auth, express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  done(req.query.id, { type: 'text', body: req.body });
  res.send('ok');
});
app.post('/esp/file', auth, express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
  done(req.query.id, { type: 'file', body: req.body });
  res.send('ok');
});

/* ---------- Cote navigateur ---------- */
app.get('/api/status', auth, (req, res) => {
  res.json({ online: Date.now() - lastSeen < 8000 });
});
app.get('/api/list', auth, async (req, res) => {
  try { const r = await ask('list'); res.type('json').send(r.body); }
  catch (e) { res.status(504).send(e.message); }
});
app.get('/api/delete', auth, async (req, res) => {
  try { const r = await ask('delete', req.query.file); res.send(r.body); }
  catch (e) { res.status(504).send(e.message); }
});
app.get('/api/deleteall', auth, async (req, res) => {
  try { const r = await ask('deleteall'); res.send(r.body); }
  catch (e) { res.status(504).send(e.message); }
});
app.get('/api/table', auth, async (req, res) => {
  try {
    const r = await ask('table');
    if (r.type !== 'file') return res.status(404).send('data introuvable');
    res.type('text/plain; charset=utf-8').send(r.body.toString('utf8'));
  } catch (e) { res.status(504).send(e.message); }
});
app.get('/api/download', auth, async (req, res) => {
  try {
    const r = await ask('download', req.query.file);
    if (r.type !== 'file') return res.status(404).send('Fichier introuvable');
    const name = String(req.query.file).replace(/[^\w.\-]/g, '_');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(r.body);
  } catch (e) { res.status(504).send(e.message); }
});

/* ---------- Page web ---------- */
const PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SD ESP32-CAM</title>
<style>
body{font-family:Arial;text-align:center}
button{margin:5px;padding:8px;cursor:pointer}
#st{font-weight:bold}
</style></head>
<body>
<h2>Gestion SD Card (cloud)</h2>
<p>ESP32 : <span id="st">...</span></p>
<button onclick="loadTable()" style="background:green;color:white">Afficher le tableau (data)</button>
<button onclick="loadFiles()">Actualiser fichiers</button>
<button onclick="deleteAllFiles()" style="background:red;color:white">Delete All</button>
<p id="msg"></p>
<div id="table"></div>
<h3>Fichiers</h3>
<div id="fileList"></div>
<script>
const K = new URLSearchParams(location.search).get('k') || '';
const q = (p) => p + (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K);
const msg = (t) => document.getElementById('msg').textContent = t;

function status(){
  fetch(q('/api/status')).then(r=>r.json()).then(d=>{
    const s=document.getElementById('st');
    s.textContent=d.online?'EN LIGNE':'HORS LIGNE';
    s.style.color=d.online?'green':'red';
  }).catch(()=>{});
}
setInterval(status,3000); status();

function loadTable(){
  msg('Chargement du tableau...');
  fetch(q('/api/table')).then(r=>{
    if(!r.ok) throw new Error(r.status==404?'Fichier data introuvable sur la SD':'ESP32 ne repond pas');
    return r.text();
  }).then(t=>{
    const rows=t.split(/\\r?\\n/).filter(l=>l.trim()!=='');
    let h='<table border="1" cellpadding="6" style="margin:auto;border-collapse:collapse"><tr><th>Nom</th><th>Prenom</th><th>ID</th><th>Heure</th><th>Date</th><th>Photo</th></tr>';
    rows.forEach(l=>{
      const c=l.split(',');
      h+='<tr>';
      for(let i=0;i<5;i++) h+='<td>'+(c[i]||'')+'</td>';
      const p=c[5]||'';
      h+='<td>'+(p?'<a href="'+q('/api/download?file='+encodeURIComponent(p))+'">'+p+'</a>':'')+'</td></tr>';
    });
    document.getElementById('table').innerHTML=h+'</table>';
    msg('');
  }).catch(e=>msg(e.message));
}
function loadFiles(){
  msg('Chargement...');
  fetch(q('/api/list')).then(r=>{ if(!r.ok) throw new Error('ESP32 ne repond pas'); return r.json(); })
  .then(data=>{
    let html='';
    data.files.forEach(f=>{
      const e=encodeURIComponent(f);
      html+='<div>'+f+' <a href="'+q('/api/download?file='+e)+'" download><button>Telecharger</button></a>'
          +'<button onclick="deleteFile(\\''+e+'\\')">Supprimer</button></div>';
    });
    document.getElementById('fileList').innerHTML=html||'(vide)';
    msg('');
  }).catch(e=>msg(e.message));
}
function deleteFile(e){
  msg('Suppression...');
  fetch(q('/api/delete?file='+e)).then(()=>loadFiles());
}
function deleteAllFiles(){
  if(confirm('Supprimer tous les fichiers de la carte SD ?')){
    fetch(q('/api/deleteall')).then(r=>r.text()).then(t=>{alert(t);loadFiles();});
  }
}
loadTable();
loadFiles();
</script></body></html>`;

app.get('/sd', auth, (req, res) => res.send(PAGE));

/* ---------- Page avec uniquement le tableau ---------- */
const TABLE_PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tableau</title>
<style>
body{font-family:Arial;margin:20px}
table{border-collapse:collapse;margin:auto}
th,td{border:1px solid #888;padding:6px 12px;text-align:center}
th{background:#eee}
</style></head>
<body>
<div id="t">Chargement...</div>
<script>
const K = new URLSearchParams(location.search).get('k') || '';
fetch('/api/table?k=' + encodeURIComponent(K))
.then(r=>{ if(!r.ok) throw new Error(r.status==404?'Fichier data introuvable sur la SD':'ESP32 ne repond pas'); return r.text(); })
.then(t=>{
  const rows=t.split(/\\r?\\n/).filter(l=>l.trim()!=='');
  let h='<table><tr><th>Nom</th><th>Prenom</th><th>ID</th><th>Heure</th><th>Date</th><th>Photo</th></tr>';
  rows.forEach(l=>{
    const c=l.split(',');
    h+='<tr>';
    for(let i=0;i<6;i++) h+='<td>'+(c[i]||'')+'</td>';
    h+='</tr>';
  });
  document.getElementById('t').innerHTML=h+'</table>';
})
.catch(e=>{ document.getElementById('t').textContent=e.message; });
</script></body></html>`;
app.get('/table', auth, (req, res) => res.send(TABLE_PAGE));

app.get('/', (req, res) => res.send('Serveur OK. Ouvrir /sd?k=VOTRE_CLE'));

app.listen(process.env.PORT || 3000, () => console.log('Serveur demarre'));
