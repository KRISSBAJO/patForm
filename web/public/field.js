/*
 * Field checklists that work without signal (PRD OPS-09).
 *
 * The list of jobs is kept on the phone. Answers and photos are saved on the
 * phone as they are typed, and finished work waits in a queue until there is
 * a connection. Each job carries the version it was opened at, so a phone
 * that was offline cannot overwrite newer work: the server refuses and the
 * item is shown as a conflict instead of being lost.
 *
 * Only maintenance checklists work offline. Approvals and access changes are
 * online only, on purpose. Everything is written with textContent; nothing
 * from the server is ever parsed as HTML.
 */
(function () {
  'use strict';
  var DB_NAME = 'patform-field';
  var app = document.getElementById('app');
  var statusBox = document.getElementById('status');
  var net = document.getElementById('net');
  var data = null;        // last list from the server: { jobs, captureLocation }
  var queue = [];         // waiting work
  var openJobId = null;
  var syncing = false;
  var notice = null;      // { kind, text }

  // ---------------------------------------------------------------- storage
  function db() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode); var s = t.objectStore(store); var out = fn(s);
        t.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  var kvGet = function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); };
  var kvSet = function (k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); };
  var kvDel = function (k) { return tx('kv', 'readwrite', function (s) { s.delete(k); }); };
  var qAll = function () { return tx('queue', 'readonly', function (s) { return s.getAll(); }); };
  var qPut = function (item) { return tx('queue', 'readwrite', function (s) { return s.put(item); }); };
  var qDel = function (id) { return tx('queue', 'readwrite', function (s) { s.delete(id); }); };

  // ------------------------------------------------------------------- dom
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function day(v) { return v ? new Date(v + 'T00:00:00').toLocaleDateString() : ''; }

  // -------------------------------------------------------------- network
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, body: json }; });
      });
  }

  function refresh() {
    if (!navigator.onLine) return Promise.resolve();
    return api('GET', '/api/ops/maintenance').then(function (r) {
      if (r.status === 401) { notice = { kind: 'bad', text: 'You are signed out. Sign in on the console, then come back here.' }; return; }
      if (!r.ok) { notice = { kind: 'bad', text: r.body.reason || r.body.error || 'Could not load the jobs.' }; return; }
      // Keep the version a queued draft already moved on, so the next send matches.
      data = { jobs: r.body.jobs.filter(function (j) { return j.status === 'open'; }), captureLocation: !!r.body.captureLocation, at: new Date().toISOString() };
      return kvSet('data', data);
    }).catch(function () { /* offline after all: keep what we have */ });
  }

  // ------------------------------------------------------------------ sync
  function sync() {
    if (syncing || !navigator.onLine) return Promise.resolve();
    syncing = true;
    var blockedJobs = {};
    return qAll().then(function (items) {
      items.sort(function (a, b) { return a.id - b.id; });
      var chain = Promise.resolve(true);
      items.forEach(function (item) {
        chain = chain.then(function (go) {
          if (!go) return false;
          if (item.state !== 'waiting' || blockedJobs[item.jobId]) { blockedJobs[item.jobId] = true; return true; }
          return sendItem(item, items).then(function (result) {
            if (result === 'offline') return false;
            if (result === 'signedout') { notice = { kind: 'bad', text: 'You are signed out. Sign in on the console; your work stays saved here.' }; return false; }
            if (result !== 'sent') blockedJobs[item.jobId] = true;
            return true;
          });
        });
      });
      return chain;
    }).then(refresh).then(load).finally(function () { syncing = false; render(); });
  }

  function sendItem(item, all) {
    // Photos first, one by one; each upload is remembered so a retry never sends it twice.
    var photos = item.photos || [];
    var chain = Promise.resolve('ok');
    photos.forEach(function (p) {
      chain = chain.then(function (r) {
        if (r !== 'ok' || p.ref) return r;
        return api('POST', '/api/ops/photos', { jobId: item.jobId, filename: p.name, base64: p.base64 }).then(function (res) {
          if (res.status === 401) return 'signedout';
          if (!res.ok) { item.state = 'error'; item.message = 'Photo ' + p.name + ': ' + (res.body.reason || res.body.error || 'refused'); return qPut(item).then(function () { return 'error'; }); }
          p.ref = res.body.reference; delete p.base64;
          return qPut(item).then(function () { return 'ok'; });
        }, function () { return 'offline'; });
      });
    });
    return chain.then(function (r) {
      if (r !== 'ok') return r;
      var body = { version: item.version, results: item.results, findings: item.findings, photos: photos.map(function (p) { return p.ref; }) };
      if (item.location) body.location = item.location;
      return api('POST', '/api/ops/maintenance/jobs/' + item.jobId + '/' + (item.kind === 'complete' ? 'complete' : 'draft'), body).then(function (res) {
        if (res.status === 401) return 'signedout';
        if (!res.ok) {
          var msg = res.body.reason || res.body.error || ('HTTP ' + res.status);
          item.state = /saved elsewhere/.test(msg) ? 'conflict' : 'error';
          item.message = msg;
          return qPut(item).then(function () { return item.state; });
        }
        var steps = [qDel(item.id)];
        if (item.kind === 'draft' && res.body.version !== undefined) {
          // Later work for this job was queued against the old version.
          all.forEach(function (o) { if (o.id !== item.id && o.jobId === item.jobId && o.state === 'waiting') { o.version = res.body.version; steps.push(qPut(o)); } });
        }
        if (item.kind === 'complete') steps.push(kvDel('job:' + item.jobId));
        return Promise.all(steps).then(function () { return 'sent'; });
      }, function () { return 'offline'; });
    });
  }

  // ---------------------------------------------------------------- photos
  function shrink(file) {
    // Phones take large photos; send at most 1600 px as JPEG, which also strips location data.
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', 0.8); });
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result).split(',')[1]); };
        r.onerror = function () { reject(r.error); };
        r.readAsDataURL(blob);
      });
    });
  }

  // ------------------------------------------------------------------ jobs
  function localJob(jobId) {
    return kvGet('job:' + jobId).then(function (j) { return j || { results: {}, findings: '', photos: [] }; });
  }

  function queueWork(job, kind, local) {
    var item = { jobId: job.id, kind: kind, version: job.version, results: local.results, findings: local.findings, photos: local.photos.map(function (p) { return { name: p.name, base64: p.base64 }; }), location: local.location || null, state: 'waiting', title: job.title, tag: job.tag, at: new Date().toISOString() };
    return qPut(item).then(function () {
      if (kind === 'draft') local.photos = []; // the queued draft carries them
      return kind === 'complete' ? kvDel('job:' + job.id) : kvSet('job:' + job.id, local);
    }).then(function () {
      notice = { kind: '', text: navigator.onLine ? 'Sending…' : 'Saved on this phone. It will send when you are back online.' };
      if (kind === 'complete') openJobId = null;
      return load();
    }).then(function () { render(); return sync(); });
  }

  function renderJob(job) {
    localJob(job.id).then(function (local) {
      var save = function () { return kvSet('job:' + job.id, local); };
      var checks = job.checklist.map(function (c) {
        var name = 'chk-' + job.id + '-' + c;
        return el('div', { class: 'check' }, [el('div', { text: c }), el('div', null, ['pass', 'fail', 'na'].map(function (v) {
          return el('label', null, [el('input', { type: 'radio', name: name, checked: local.results[c] === v, onchange: function () { local.results[c] = v; save(); } }), v === 'na' ? 'N/A' : v === 'pass' ? 'Pass' : 'Fail']);
        }))]);
      });
      var findings = el('textarea', { 'aria-label': 'Findings', placeholder: 'Findings (required if anything fails)', oninput: function () { local.findings = findings.value; save(); } });
      findings.value = local.findings || '';
      var photoInfo = el('p', { class: 'muted', text: local.photos.length ? local.photos.length + ' photo(s) ready to send' : 'No photos yet' });
      var photoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, 'aria-label': 'Add photos', onchange: function () {
        var files = Array.prototype.slice.call(photoInput.files || []);
        photoInfo.textContent = 'Preparing photos…';
        files.reduce(function (p, f) { return p.then(function () { return shrink(f).then(function (b64) { local.photos.push({ name: (f.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', base64: b64 }); }); }); }, Promise.resolve())
          .then(save).then(function () { photoInfo.textContent = local.photos.length + ' photo(s) ready to send'; })
          .catch(function () { photoInfo.textContent = 'That photo could not be read.'; });
      } });
      var loc = data && data.captureLocation ? el('label', null, [el('input', { type: 'checkbox', onchange: function (e) {
        if (!e.target.checked) { local.location = null; save(); return; }
        navigator.geolocation.getCurrentPosition(function (pos) { local.location = { lat: pos.coords.latitude, lng: pos.coords.longitude }; save(); }, function () { e.target.checked = false; });
      } }), ' Add where I am (this job only)']) : null;
      var missing = function () { return job.checklist.filter(function (c) { return !local.results[c]; }); };
      app.replaceChildren(el('div', { class: 'card' }, [
        el('h2', { text: job.title + ' · ' + job.tag }),
        el('p', { class: 'muted', text: job.asset + ' · due ' + day(job.due_on) }),
      ].concat(checks).concat([
        findings, el('div', { class: 'check' }, [photoInput, photoInfo]), loc,
        el('div', { class: 'row' }, [
          el('button', { text: 'Save draft', onclick: function () { queueWork(job, 'draft', local); } }),
          el('button', { class: 'primary', text: 'Finish', onclick: function () {
            var m = missing();
            if (m.length) { notice = { kind: 'warn', text: 'Answer every check first: ' + m.join(', ') }; render(); return; }
            if (job.checklist.some(function (c) { return local.results[c] === 'fail'; }) && !String(local.findings || '').trim()) { notice = { kind: 'warn', text: 'Describe what failed.' }; render(); return; }
            queueWork(job, 'complete', local);
          } }),
          el('button', { text: 'Back', onclick: function () { openJobId = null; render(); } }),
        ]),
      ])));
    });
  }

  function renderStatus() {
    statusBox.replaceChildren();
    var waiting = queue.filter(function (q) { return q.state === 'waiting'; });
    var stuck = queue.filter(function (q) { return q.state !== 'waiting'; });
    if (notice) statusBox.appendChild(el('div', { class: 'banner ' + (notice.kind || ''), text: notice.text }));
    if (waiting.length) statusBox.appendChild(el('div', { class: 'banner warn' }, [
      el('span', { text: waiting.length + ' waiting to send' + (navigator.onLine ? '. ' : ' — they send when you are back online. ') }),
      navigator.onLine ? el('button', { text: 'Send now', onclick: function () { sync(); } }) : null,
    ]));
    stuck.forEach(function (q) {
      statusBox.appendChild(el('div', { class: 'banner bad' }, [
        el('div', { text: (q.kind === 'complete' ? 'Finished ' : 'Draft for ') + q.title + ' · ' + q.tag + (q.state === 'conflict' ? ' — someone saved newer work for this job.' : ' — refused.') }),
        el('div', { class: 'muted', text: q.message || '' }),
        el('div', { class: 'row' }, [
          q.state === 'conflict' ? el('button', { text: 'Use my answers on the latest version', onclick: function () {
            var job = data && data.jobs.find(function (j) { return j.id === q.jobId; });
            if (!job) { notice = { kind: 'bad', text: 'That job is no longer open.' }; render(); return; }
            q.version = job.version; q.state = 'waiting'; q.message = null;
            qPut(q).then(load).then(sync);
          } }) : null,
          el('button', { text: 'Discard', onclick: function () { qDel(q.id).then(load).then(render); } }),
        ]),
      ]));
    });
  }

  function render() {
    net.textContent = navigator.onLine ? 'Online' : 'Offline';
    renderStatus();
    if (!data) {
      app.replaceChildren(el('div', { class: 'card' }, [el('p', { text: navigator.onLine ? 'No jobs loaded yet.' : 'No jobs saved on this phone yet. Open this page once with signal to load them.' }), el('a', { href: '/console', text: 'Open the console' })]));
      return;
    }
    if (openJobId) {
      var job = data.jobs.find(function (j) { return j.id === openJobId; });
      if (job) return renderJob(job);
      openJobId = null;
    }
    var finishing = {};
    queue.forEach(function (q) { if (q.kind === 'complete') finishing[q.jobId] = true; });
    var jobs = data.jobs.filter(function (j) { return !finishing[j.id]; });
    app.replaceChildren(el('p', { class: 'muted', text: 'Jobs for your team. ' + (data.at ? 'Updated ' + new Date(data.at).toLocaleString() + '.' : '') }));
    if (!jobs.length) app.appendChild(el('div', { class: 'card' }, [el('p', { text: 'Nothing due.' })]));
    jobs.forEach(function (j) {
      var overdue = j.due_on < today();
      app.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'row', style: 'justify-content:space-between' }, [el('h2', { text: j.title + ' · ' + j.tag }), el('span', { class: 'pill ' + (overdue ? 'overdue' : 'due'), text: (overdue ? 'Overdue ' : 'Due ') + day(j.due_on) })]),
        el('p', { class: 'muted', text: j.asset + ' · ' + j.checklist.length + ' checks' }),
        el('button', { class: 'primary', text: 'Do it', onclick: function () { openJobId = j.id; notice = null; render(); } }),
      ]));
    });
  }

  function load() {
    return Promise.all([kvGet('data'), qAll()]).then(function (r) { data = r[0] || data; queue = r[1] || []; });
  }

  window.addEventListener('online', function () { notice = null; render(); sync(); });
  window.addEventListener('offline', render);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
  setInterval(function () { if (document.visibilityState === 'visible' && queue.length) sync(); }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  load().then(render).then(refresh).then(load).then(render).then(sync);
})();
