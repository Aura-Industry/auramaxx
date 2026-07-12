/**
 * App SDK source code — injected into third-party app iframes.
 * Provides the AuraApp API for communication with the host bridge.
 *
 * API:
 *   app.send(message)              → Natural language message to agent (postMessage)
 *   app.fetch(url, options)        → Proxy external HTTP request via server (direct fetch)
 *   app.on(channel, callback)      → Subscribe to real-time data channels (postMessage)
 *   app.storage.get(key)           → Read from persistent storage (direct fetch)
 *   app.storage.set(key, value)    → Write to persistent storage (direct fetch)
 *   app.storage.delete(key)        → Delete from persistent storage (direct fetch)
 *
 * Globals injected by host before this script runs:
 *   window.__AURA_TOKEN__      — Bearer token for authenticated API calls
 *   window.__AURA_API_BASE__   — Base URL for wallet API (e.g. http://127.0.0.1:4242)
 *   window.__AURA_APP_ID__  — App folder name (used for scoped storage)
 */

export const APP_SDK_SOURCE = `
(function() {
  var _callbacks = {};
  var _subscriptions = {};
  var _requestId = 0;

  var TOKEN = window.__AURA_TOKEN__ || '';
  var API_BASE = window.__AURA_API_BASE__ || 'http://127.0.0.1:4242';
  var APP_ID = window.__AURA_APP_ID__ || '';

  function generateId() {
    return 'req_' + (++_requestId) + '_' + Date.now();
  }

  function postToHost(msg) {
    window.parent.postMessage(msg, '*');
  }

  function request(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = generateId();
      _callbacks[id] = { resolve: resolve, reject: reject };
      postToHost({ type: type, id: id, payload: payload });
      // Timeout after 30s
      setTimeout(function() {
        if (_callbacks[id]) {
          delete _callbacks[id];
          reject(new Error('Request timed out'));
        }
      }, 30000);
    });
  }

  /** Direct fetch to wallet API with Bearer token */
  function apiFetch(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (TOKEN) {
      opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opts).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok) throw new Error(data.error || 'API error ' + res.status);
        return data;
      });
    });
  }

  // Listen for messages from host bridge
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    // Response to a request
    if (msg.type === 'app:response' && msg.id && _callbacks[msg.id]) {
      var cb = _callbacks[msg.id];
      delete _callbacks[msg.id];
      if (msg.error) {
        cb.reject(new Error(msg.error));
      } else {
        cb.resolve(msg.data);
      }
      return;
    }

    // Data push from subscribed channel
    if (msg.type === 'app:data' && msg.channel && _subscriptions[msg.channel]) {
      _subscriptions[msg.channel].forEach(function(fn) {
        try { fn(msg.data); } catch(e) { console.error('Subscription callback error:', e); }
      });
    }
  });

  window.AuraApp = {
    send: function(message) {
      return apiFetch('POST', '/apps/' + APP_ID + '/message', { message: message })
        .then(function(data) { return data.reply; });
    },

    on: function(channel, callback) {
      if (!_subscriptions[channel]) {
        _subscriptions[channel] = [];
        postToHost({ type: 'app:subscribe', channel: channel });
      }
      _subscriptions[channel].push(callback);
      // Return unsubscribe function
      return function() {
        var subs = _subscriptions[channel];
        if (subs) {
          var idx = subs.indexOf(callback);
          if (idx !== -1) subs.splice(idx, 1);
        }
      };
    },

    fetch: function(url, options) {
      return apiFetch('POST', '/apps/' + APP_ID + '/fetch', {
        url: url,
        method: (options && options.method) || 'GET',
        headers: options && options.headers,
        body: options && options.body
      }).then(function(res) { return res.data; });
    },

    action: function(params) {
      return apiFetch('POST', '/actions', params);
    },

    storage: {
      get: function(key) {
        return apiFetch('GET', '/apps/' + APP_ID + '/storage/' + encodeURIComponent(key))
          .then(function(data) { return data.value; })
          .catch(function(err) {
            // 404 = key not found, return null
            if (err.message && err.message.indexOf('not found') !== -1) return null;
            throw err;
          });
      },
      set: function(key, value) {
        return apiFetch('PUT', '/apps/' + APP_ID + '/storage/' + encodeURIComponent(key), { value: value })
          .then(function(data) { return data.value; });
      },
      delete: function(key) {
        return apiFetch('DELETE', '/apps/' + APP_ID + '/storage/' + encodeURIComponent(key))
          .then(function() { return true; })
          .catch(function(err) {
            if (err.message && err.message.indexOf('not found') !== -1) return false;
            throw err;
          });
      }
    }
  };
})();
`;
