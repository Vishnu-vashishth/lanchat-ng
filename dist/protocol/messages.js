// Application-layer messages carried over the encrypted channel. Every one of
// these is encrypted end-to-end; none of it (nicknames, rooms, typing state)
// is ever visible to a network observer.
export const DEFAULT_ROOM = 'lobby';
export const PROTOCOL_VERSION = 1;
export function isMessage(x) {
    return !!x && typeof x === 'object' && typeof x.t === 'string';
}
