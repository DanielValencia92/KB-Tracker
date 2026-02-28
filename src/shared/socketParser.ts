/**
 * socketParser.ts
 *
 * Parses raw Socket.IO v4 Engine.IO text frames into structured objects.
 *
 * Socket.IO v4 text frame format (without the msgpack parser):
 *   <engineio-packet-type><socketio-packet-type>[<namespace>,][<ack-id>,]<json-payload>
 *
 * Engine.IO packet types: 0=open 1=close 2=ping 3=pong 4=message 5=upgrade 6=noop
 * Socket.IO packet types: 0=CONNECT 1=DISCONNECT 2=EVENT 3=ACK 4=CONNECT_ERROR 5=BINARY
 *
 * The frames we care about are Engine.IO message (4) + Socket.IO event (2):
 *   "42["gamestate", {...}]"    →  event "gamestate" with one arg
 *   "42["game", {...}]"         →  etc.
 */

import type { IGameState, SocketIOFrame } from './types';

const EIO_MESSAGE = '4';
const SIO_EVENT = '2';
const SIO_ACK = '3';

export function parseFrame(raw: string): SocketIOFrame | null {
  // Must start with EIO message type
  if (!raw.startsWith(EIO_MESSAGE)) {
    console.debug('[KB Tracker] parseFrame: skip (not EIO message), prefix:', raw.slice(0, 4));
    return null;
  }

  const sioType = raw[1];

  if (sioType !== SIO_EVENT && sioType !== SIO_ACK) {
    return { type: 'other' };
  }

  // Slice past the two type chars; strip optional namespace ("/game,")
  let body = raw.slice(2);
  if (body.startsWith('/')) {
    const commaIdx = body.indexOf(',');
    if (commaIdx === -1) {
      console.debug('[KB Tracker] parseFrame: malformed namespace, no comma');
      return null;
    }
    body = body.slice(commaIdx + 1);
  }

  // Strip optional ack id (digits before the '[')
  body = body.replace(/^\d+(?=\[)/, '');

  // Now body should be a JSON array
  if (!body.startsWith('[')) {
    console.debug('[KB Tracker] parseFrame: body does not start with [, got:', body.slice(0, 20));
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any[] = JSON.parse(body);
    if (!Array.isArray(parsed)) return null;

    if (sioType === SIO_EVENT) {
      const [event, ...data] = parsed;
      const evStr = String(event);
      console.debug('[KB Tracker] parseFrame: event=', evStr);
      return { type: 'event', event: evStr, data };
    } else {
      return { type: 'ack', data: parsed };
    }
  } catch (err) {
    console.debug('[KB Tracker] parseFrame: JSON.parse failed:', err, '| body prefix:', body.slice(0, 60));
    return null;
  }
}

export function extractGameState(frame: SocketIOFrame): IGameState | null {
  if (frame.type !== 'event' || frame.event !== 'gamestate') return null;
  const payload = frame.data?.[0];
  if (!payload || typeof payload !== 'object') return null;
  // Basic sanity checks
  if (!payload.id || !payload.players || !Array.isArray(payload.winners)) return null;
  return payload as IGameState;
}
