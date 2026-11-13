// Application-layer messages carried over the encrypted channel. Every one of
// these is encrypted end-to-end; none of it (nicknames, rooms, typing state)
// is ever visible to a network observer.

export const DEFAULT_ROOM = 'lobby';
export const PROTOCOL_VERSION = 1;

export interface HelloMsg {
  t: 'hello';
  nick: string;
  rooms: string[];
  port: number; // the TCP port this node listens on (for peer gossip)
  ver: number;
}
export interface PeersMsg {
  t: 'peers';
  peers: { host: string; port: number; fp: string }[];
}
export interface ChatMsg {
  t: 'chat';
  id: string;
  room: string;
  body: string;
  ts: number;
}
export interface TypingMsg {
  t: 'typing';
  room: string;
  on: boolean;
}
export interface ReceiptMsg {
  t: 'receipt';
  room: string;
  ids: string[];
  kind: 'delivered' | 'read';
}
export interface JoinMsg {
  t: 'join';
  room: string;
}
export interface LeaveMsg {
  t: 'leave';
  room: string;
}
export interface PingMsg {
  t: 'ping';
}
export interface PongMsg {
  t: 'pong';
}

export type Message =
  | HelloMsg
  | PeersMsg
  | ChatMsg
  | TypingMsg
  | ReceiptMsg
  | JoinMsg
  | LeaveMsg
  | PingMsg
  | PongMsg;

export function isMessage(x: unknown): x is Message {
  return !!x && typeof x === 'object' && typeof (x as { t?: unknown }).t === 'string';
}
