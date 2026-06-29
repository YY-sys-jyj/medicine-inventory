// Lightweight local Supabase client used by this static GitHub Pages app.
// It avoids external CDN dependencies and includes token refresh plus XHR fallback.
window.supabase = {
  createClient: function(url, key) {
    var headers = {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    };
    var _refreshToken = null;
    var storageKey = "sb-" + new URL(url).hostname + "-auth-token";

    function getHeader(headersObj, name) {
      if (!headersObj) return null;
      if (typeof headersObj.get === "function") return headersObj.get(name);
      var low = name.toLowerCase();
      for (var k in headersObj) if (k.toLowerCase() === low) return headersObj[k];
      return null;
    }

    function responseLike(status, text, headerText) {
      var map = {};
      (headerText || "").split(/\r?\n/).forEach(function(line) {
        var i = line.indexOf(":");
        if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      });
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: function(name) { return map[name.toLowerCase()] || null; } },
        text: function() { return Promise.resolve(text || ""); }
      };
    }

    function xhrRequest(fullUrl, fetchOpts) {
      return new Promise(function(resolve, reject) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open(fetchOpts.method || "GET", fullUrl, true);
          xhr.timeout = 20000;
          var h = fetchOpts.headers || {};
          for (var k in h) xhr.setRequestHeader(k, h[k]);
          xhr.onload = function() { resolve(responseLike(xhr.status, xhr.responseText, xhr.getAllResponseHeaders())); };
          xhr.onerror = function() { reject(new Error("XHR network error")); };
          xhr.ontimeout = function() { reject(new Error("XHR timeout")); };
          xhr.send(fetchOpts.body || null);
        } catch (e) {
          reject(e);
        }
      });
    }

    function doRequest(fullUrl, fetchOpts) {
      if (typeof fetch === "function") {
        return fetch(fullUrl, fetchOpts).catch(function(fetchError) {
          if (typeof XMLHttpRequest === "function") return xhrRequest(fullUrl, fetchOpts);
          throw fetchError;
        });
      }
      if (typeof XMLHttpRequest === "function") return xhrRequest(fullUrl, fetchOpts);
      return Promise.reject(new Error("No browser request API available"));
    }

    function parseResponse(r) {
      if (!r.ok) {
        return r.text().then(function(t) {
          try {
            var e = JSON.parse(t);
            return { error: { message: e.error || e.error_description || e.msg || e.message || ("status:" + r.status + " body:" + t), status: r.status, code: e.code || e.error_code } };
          } catch (x) {
            return { error: { message: "status:" + r.status + " body:" + String(t || "").substring(0, 180), status: r.status } };
          }
        });
      }
      if (r.status === 204 || getHeader(r.headers, "content-length") === "0") return Promise.resolve({ data: null, error: null });
      return r.text().then(function(t) {
        if (!t) return { data: null, error: null };
        try { return { data: JSON.parse(t), error: null }; }
        catch (e) { return { data: t, error: null }; }
      });
    }

    function api(path, opts, retry) {
      opts = opts || {};
      var h = {};
      for (var k in headers) h[k] = headers[k];
      if (opts.headers) for (var hk in opts.headers) h[hk] = opts.headers[hk];
      var fetchOpts = { method: opts.method || "GET", headers: h };
      if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
      return doRequest(url + path, fetchOpts).then(function(r) {
        if (r.status === 401 && !retry && _refreshToken) {
          return refreshSessionInternal().then(function(rr) {
            if (rr.error) return parseResponse(r);
            return api(path, opts, true);
          });
        }
        return parseResponse(r);
      }).catch(function(e) {
        return { error: { message: e.message || "Network error", status: 0 } };
      });
    }

    function normAuth(r) {
      if (r.data && !r.error) {
        var d = r.data;
        r.data = {
          session: {
            access_token: d.access_token,
            token_type: d.token_type,
            expires_in: d.expires_in,
            expires_at: d.expires_at,
            refresh_token: d.refresh_token,
            user: d.user
          }
        };
      }
      return r;
    }

    function setSessionData(data) {
      try {
        var d = data.session || data;
        if (!d) return;
        var obj = {
          user: d.user,
          access_token: d.access_token,
          expires_at: d.expires_at
        };
        if (d.refresh_token) {
          obj.refresh_token = d.refresh_token;
          _refreshToken = d.refresh_token;
        }
        if (d.access_token) headers.Authorization = "Bearer " + d.access_token;
        localStorage.setItem(storageKey, JSON.stringify(obj));
      } catch (e) {}
    }

    function readStoredSession() {
      try {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (p.refresh_token) _refreshToken = p.refresh_token;
        if (p.access_token) headers.Authorization = "Bearer " + p.access_token;
        return { session: { user: p.user, access_token: p.access_token, expires_at: p.expires_at, refresh_token: p.refresh_token } };
      } catch (e) {
        return null;
      }
    }

    function refreshSessionInternal() {
      if (!_refreshToken) {
        var stored = readStoredSession();
        _refreshToken = stored && stored.session && stored.session.refresh_token;
      }
      if (!_refreshToken) return Promise.resolve({ data: null, error: { message: "No refresh token", status: 401 } });
      return api("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: _refreshToken },
        headers: { Authorization: "Bearer " + key }
      }, true).then(function(r) {
        if (!r.error && r.data) setSessionData(r.data);
        return normAuth(r);
      });
    }

    function QB(table) {
      var qb = {};
      var _filters = [], _order = null, _ascending = true, _limit = null, _single = false, _cols = "*";
      function addFilter(col, op, val) { _filters.push({ col: col, op: op, val: val }); return qb; }
      function buildQ() {
        var q = "/rest/v1/" + table + "?select=" + encodeURIComponent(_cols).replace(/%2A/g, "*").replace(/%2C/g, ",");
        _filters.forEach(function(f) {
          q += "&" + encodeURIComponent(f.col) + "=" + f.op + "." + encodeURIComponent(f.val);
        });
        if (_order) q += "&order=" + encodeURIComponent(_order) + "." + (_ascending ? "asc" : "desc");
        if (_limit) q += "&limit=" + _limit;
        return q;
      }
      qb.then = function(resolve, reject) {
        var p = api(buildQ());
        if (_single) {
          p = p.then(function(r) {
            if (r.data && Array.isArray(r.data)) r.data = r.data[0] || null;
            return r;
          });
        }
        return p.then(resolve, reject);
      };
      qb.select = function(c) { if (c) _cols = c; return qb; };
      qb.eq = function(col, val) { return addFilter(col, "eq", val); };
      qb.neq = function(col, val) { return addFilter(col, "neq", val); };
      qb.in = function(col, vals) { return addFilter(col, "in", "(" + (vals || []).join(",") + ")"); };
      qb.order = function(col, opts) { _order = col; if (opts && opts.ascending === false) _ascending = false; return qb; };
      qb.limit = function(n) { _limit = n; return qb; };
      qb.single = function() { _limit = 1; _single = true; return qb; };
      qb.maybeSingle = function() { return qb.single(); };
      qb.insert = function(rows) { return api("/rest/v1/" + table, { method: "POST", body: rows, headers: { Prefer: "return=representation" } }); };
      qb.update = function(row) {
        var qb2 = {
          _filters: _filters.slice(),
          then: function(resolve, reject) {
            var q = "/rest/v1/" + table + "?";
            qb2._filters.forEach(function(f) { q += encodeURIComponent(f.col) + "=" + f.op + "." + encodeURIComponent(f.val) + "&"; });
            return api(q, { method: "PATCH", body: row }).then(resolve, reject);
          },
          eq: function(col, val) { qb2._filters.push({ col: col, op: "eq", val: val }); return qb2; },
          in: function(col, vals) { qb2._filters.push({ col: col, op: "in", val: "(" + (vals || []).join(",") + ")" }); return qb2; }
        };
        return qb2;
      };
      qb.delete = function() {
        var qb2 = {
          _filters: _filters.slice(),
          then: function(resolve, reject) {
            var q = "/rest/v1/" + table + "?";
            qb2._filters.forEach(function(f) { q += encodeURIComponent(f.col) + "=" + f.op + "." + encodeURIComponent(f.val) + "&"; });
            return api(q, { method: "DELETE" }).then(resolve, reject);
          },
          eq: function(col, val) { qb2._filters.push({ col: col, op: "eq", val: val }); return qb2; },
          in: function(col, vals) { qb2._filters.push({ col: col, op: "in", val: "(" + (vals || []).join(",") + ")" }); return qb2; }
        };
        return qb2;
      };
      return qb;
    }

    return {
      auth: {
        getSession: function() { return Promise.resolve({ data: readStoredSession(), error: null }); },
        refreshSession: function() { return refreshSessionInternal(); },
        _setSession: setSessionData,
        signInWithPassword: function(opts) {
          return api("/auth/v1/token?grant_type=password", {
            method: "POST",
            body: { email: opts.email, password: opts.password, gotrue_meta_security: {} },
            headers: { Authorization: "Bearer " + key }
          }).then(function(r) { if (!r.error && r.data) setSessionData(r.data); return normAuth(r); });
        },
        signUp: function(opts) {
          return api("/auth/v1/signup", {
            method: "POST",
            body: { email: opts.email, password: opts.password },
            headers: { Authorization: "Bearer " + key }
          }).then(function(r) { if (!r.error && r.data) setSessionData(r.data); return normAuth(r); });
        },
        signOut: function() {
          try { localStorage.removeItem(storageKey); } catch (e) {}
          _refreshToken = null;
          headers.Authorization = "Bearer " + key;
          return api("/auth/v1/logout", { method: "POST" });
        },
        resetPasswordForEmail: function(opts) { return api("/auth/v1/recover", { method: "POST", body: { email: opts.email } }); },
        updateUser: function(opts) { return api("/auth/v1/user", { method: "PUT", body: opts }); }
      },
      from: function(table) { return QB(table); }
    };
  }
};
