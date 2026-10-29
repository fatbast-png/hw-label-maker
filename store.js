/* Card file library kept in the browser (IndexedDB). Files stay on this phone or computer only.
   Falls back to memory if the browser blocks storage (then files last until the page closes). */
(function (global) {
  "use strict";
  var DB_NAME = "hw-label-maker", STORE = "files", VERSION = 1;
  var memory = {}, dbPromise = null, persistent = true;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!global.indexedDB) { persistent = false; resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { persistent = false; resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { persistent = false; resolve(null); };
      req.onblocked = function () { persistent = false; resolve(null); };
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      if (!db) return fn(null);
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), s = t.objectStore(STORE), out;
        var r = fn(s);
        if (r && "onsuccess" in r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var Store = {
    isPersistent: function () { return open().then(function () { return persistent; }); },
    list: function () {
      return tx("readonly", function (s) { return s ? s.getAll() : null; }).then(function (all) {
        all = all || Object.keys(memory).map(function (k) { return clone(memory[k]); });
        return all.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      });
    },
    put: function (file) {
      file.updatedAt = Date.now();
      var copy = clone(file);
      return tx("readwrite", function (s) { if (s) return s.put(copy); memory[copy.id] = copy; return null; })
        .then(function () { return file; });
    },
    remove: function (id) {
      return tx("readwrite", function (s) { if (s) return s.delete(id); delete memory[id]; return null; });
    },
    /** Ask the browser not to clear our files when space is low (Chrome grants this for installed apps). */
    persist: function () {
      try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist(); } catch (e) { /* ignore */ }
      return Promise.resolve(false);
    }
  };
  global.LabelStore = Store;
})(typeof window !== "undefined" ? window : globalThis);
