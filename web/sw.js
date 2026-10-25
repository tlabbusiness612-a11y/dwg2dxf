/* sw.js - offline cache with manual updates.
 *
 * Releases are described by version.json (version + file list). Each release
 * lives in its own cache; the name of the one in use is kept in a small meta
 * cache. A new release is downloaded only when the page asks for it (the
 * 「更新を確認」 button), never on start-up.
 *
 * Keep this file byte-for-byte stable across releases: browsers re-check it
 * on their own, and any change to it would trigger an automatic install.
 *
 * The service worker never sees drawing data: files are read with the File
 * API and converted in a worker, and no request carries them.
 * Licensed under GPL-3.0-or-later, see LICENSE.
 */
'use strict';
var META = 'dwg2dxf-meta';
var PREFIX = 'dwg2dxf-app-';
var current = null; // name of the cache in use

function readCurrent() {
  if (current) return Promise.resolve(current);
  return caches.open(META)
    .then(function (c) { return c.match('current'); })
    .then(function (r) { return r ? r.text() : null; })
    .then(function (name) { current = name; return name; });
}

function setCurrent(name) {
  current = name;
  return caches.open(META)
    .then(function (c) { return c.put('current', new Response(name)); })
    .then(function () { return name; });
}

function fetchManifest() {
  return fetch(new Request('version.json', { cache: 'no-store' })).then(function (r) {
    if (!r.ok) throw new Error('version.json: HTTP ' + r.status);
    return r.json();
  });
}

// download every file of a release into its own cache; nothing is switched
// over unless all files arrived
function installRelease(manifest) {
  var name = PREFIX + manifest.version;
  return caches.open(name).then(function (c) {
    return Promise.all(manifest.files.map(function (u) {
      return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
        if (!res.ok) throw new Error(u + ': HTTP ' + res.status);
        return c.put(u, res);
      });
    }));
  }).then(function () { return name; }, function (err) {
    return caches.delete(name).then(function () { throw err; });
  });
}

function dropOtherReleases(keep) {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('dwg2dxf-') === 0 && k !== keep && k !== META;
    }).map(function (k) { return caches.delete(k); }));
  });
}

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    readCurrent().then(function (name) {
      // a release is already installed (sw.js itself was replaced): keep it
      return name ? caches.has(name) : false;
    }).then(function (ok) {
      if (ok) return null;
      return fetchManifest().then(installRelease).then(setCurrent).then(dropOtherReleases);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  ev.respondWith(readCurrent().then(function (name) {
    return (name ? caches.open(name) : Promise.resolve(null)).then(function (c) {
      return (c ? c.match(req, { ignoreSearch: true }) : Promise.resolve(null)).then(function (hit) {
        if (hit) return hit;
        // not part of the release (e.g. version.json during an update check)
        return fetch(req).catch(function (err) {
          if (req.mode !== 'navigate' || !c) throw err;
          return c.match('index.html').then(function (shell) {
            if (shell) return shell;
            throw err;
          });
        });
      });
    });
  }));
});

// page -> worker: 'info' (which release is in use), 'update' (download the
// latest release if it differs, then switch to it)
self.addEventListener('message', function (ev) {
  var port = ev.ports && ev.ports[0];
  if (!port) return;
  if (ev.data === 'info') {
    readCurrent().then(function (name) {
      return (name ? caches.has(name) : Promise.resolve(false)).then(function (ok) {
        port.postMessage({ cache: name, version: name ? name.slice(PREFIX.length) : null, ready: ok });
      });
    });
  } else if (ev.data === 'update') {
    var before;
    readCurrent().then(function (name) {
      before = name;
      return fetchManifest();
    }).then(function (m) {
      if (PREFIX + m.version === before) return { updated: false, version: m.version };
      return installRelease(m).then(setCurrent).then(dropOtherReleases).then(function () {
        return { updated: true, version: m.version };
      });
    }).then(function (res) {
      port.postMessage(res);
    }, function (err) {
      port.postMessage({ error: String(err && err.message || err) });
    });
  }
});
