// Normalized key events for the game screens, built from node:readline's
// 'keypress' events. Games read actions from these, never raw escape codes.
export function toKey(s, raw) {
    const ctrl = !!raw?.ctrl;
    const meta = !!raw?.meta;
    const shift = !!raw?.shift;
    let name = raw?.name ?? '';
    if (name === 'return')
        name = 'enter';
    const str = typeof s === 'string' ? s : '';
    const single = [...str].length === 1 ? str : '';
    if (!name && single)
        name = single.toLowerCase();
    if (!name)
        return null;
    let ch = '';
    if (single && !ctrl && !meta) {
        const cp = single.codePointAt(0);
        if (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0))
            ch = single;
    }
    return { name, ch, ctrl, meta, shift };
}
/** Arrow keys, WASD and vi keys as a direction, or -1. */
export function dirOf(k) {
    if (k.ctrl || k.meta)
        return -1;
    switch (k.name) {
        case 'up':
        case 'w':
        case 'k':
            return 0;
        case 'right':
        case 'd':
        case 'l':
            return 1;
        case 'down':
        case 's':
        case 'j':
            return 2;
        case 'left':
        case 'a':
        case 'h':
            return 3;
        default:
            return -1;
    }
}
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
