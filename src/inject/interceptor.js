/**
 * interceptor.js
 *
 * Injected into the Karabast page's own JavaScript context (NOT the extension
 * sandbox) by the content script, so it can proxy the native WebSocket
 * constructor before Socket.IO creates its connection.
 *
 * Must be plain JavaScript — no TypeScript syntax — because it is served as a
 * web-accessible resource and executed directly by the browser in page context.
 */

(function () {
  'use strict';

  // Match any karabast.net origin (covers play., game., www., root, etc.)
  if (!location.hostname.includes('karabast.net')) {
    return;
  }

  console.debug('[KB Tracker] interceptor.js: origin OK -', location.origin);

  const OriginalWebSocket = window.WebSocket;

  function PatchedWebSocket(url, protocols) {
    let ws;
    if (protocols !== undefined) {
      ws = new OriginalWebSocket(url, protocols);
    } else {
      ws = new OriginalWebSocket(url);
    }

    // Only intercept connections to the Karabast game server
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('karabast')) {
      console.debug('[KB Tracker] interceptor.js: patching WS connection to', urlStr);
      ws.addEventListener('message', function (event) {
        if (typeof event.data !== 'string') {
          // Binary frame — skip (Socket.IO binary events are not used for gamestate)
          return;
        }
        console.debug('[KB Tracker] WS msg (' + event.data.length + ' chars):', event.data.slice(0, 120));
        window.postMessage(
          { source: 'KB_TRACKER_WS_MSG', data: event.data },
          '*'
        );
      });
    } else {
      console.debug('[KB Tracker] interceptor.js: ignoring non-karabast WS:', urlStr);
    }

    return ws;
  }

  // Copy static properties and prototype so code that uses WebSocket.OPEN etc. still works
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN       = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING    = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED     = OriginalWebSocket.CLOSED;

  try {
    Object.defineProperty(window, 'WebSocket', {
      value: PatchedWebSocket,
      writable: true,
      configurable: true,
    });
  } catch (e) {
    window.WebSocket = PatchedWebSocket;
  }

  console.debug('[KB Tracker] WebSocket interceptor active');
})();
