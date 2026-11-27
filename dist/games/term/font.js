import { BOLD } from './canvas.js';
// A 3x5 pixel font for countdowns, scores and banners. Rendered either "big"
// (each pixel two cells wide, five rows tall) or "half" (half-block glyphs,
// one cell per pixel, three rows tall).
const GLYPHS = {
    '0': ['###', '# #', '# #', '# #', '###'],
    '1': [' # ', '## ', ' # ', ' # ', '###'],
    '2': ['###', '  #', '###', '#  ', '###'],
    '3': ['###', '  #', '###', '  #', '###'],
    '4': ['# #', '# #', '###', '  #', '  #'],
    '5': ['###', '#  ', '###', '  #', '###'],
    '6': ['###', '#  ', '###', '# #', '###'],
    '7': ['###', '  #', '  #', '  #', '  #'],
    '8': ['###', '# #', '###', '# #', '###'],
    '9': ['###', '# #', '###', '  #', '###'],
    A: ['###', '# #', '###', '# #', '# #'],
    B: ['## ', '# #', '## ', '# #', '## '],
    C: ['###', '#  ', '#  ', '#  ', '###'],
    D: ['## ', '# #', '# #', '# #', '## '],
    E: ['###', '#  ', '## ', '#  ', '###'],
    F: ['###', '#  ', '## ', '#  ', '#  '],
    G: ['###', '#  ', '# #', '# #', '###'],
    H: ['# #', '# #', '###', '# #', '# #'],
    I: ['###', ' # ', ' # ', ' # ', '###'],
    J: ['  #', '  #', '  #', '# #', '###'],
    Q: ['###', '# #', '# #', '###', '  #'],
    X: ['# #', '# #', ' # ', '# #', '# #'],
    Z: ['###', '  #', ' # ', '#  ', '###'],
    K: ['# #', '# #', '## ', '# #', '# #'],
    L: ['#  ', '#  ', '#  ', '#  ', '###'],
    M: ['# #', '###', '###', '# #', '# #'],
    N: ['## ', '# #', '# #', '# #', '# #'],
    O: ['###', '# #', '# #', '# #', '###'],
    P: ['###', '# #', '###', '#  ', '#  '],
    R: ['## ', '# #', '## ', '# #', '# #'],
    S: ['###', '#  ', '###', '  #', '###'],
    T: ['###', ' # ', ' # ', ' # ', ' # '],
    U: ['# #', '# #', '# #', '# #', '###'],
    V: ['# #', '# #', '# #', '# #', ' # '],
    W: ['# #', '# #', '###', '###', '# #'],
    Y: ['# #', '# #', '###', ' # ', ' # '],
    '!': [' # ', ' # ', ' # ', '   ', ' # '],
    ':': ['   ', ' # ', '   ', ' # ', '   '],
    '-': ['   ', '   ', '###', '   ', '   '],
    ' ': ['   ', '   ', '   ', '   ', '   '],
};
function glyph(ch) {
    return GLYPHS[ch.toUpperCase()] ?? GLYPHS[' '];
}
/** Width in cells of `text` in the given style. */
export function bigWidth(text, style = 'big') {
    const n = [...text].length;
    if (!n)
        return 0;
    return style === 'big' ? n * 8 - 2 : n * 4 - 1;
}
export function bigHeight(style = 'big') {
    return style === 'big' ? 5 : 3;
}
/** Draw `text` with its top-left corner at (x, y). */
export function bigText(s, x, y, text, fg, style = 'big', bg = -1) {
    let cx = x;
    for (const ch of text) {
        const g = glyph(ch);
        if (style === 'big') {
            for (let r = 0; r < 5; r++)
                for (let c = 0; c < 3; c++)
                    if (g[r][c] === '#') {
                        s.put(cx + c * 2, y + r, '█', fg, bg, BOLD);
                        s.put(cx + c * 2 + 1, y + r, '█', fg, bg, BOLD);
                    }
            cx += 8;
        }
        else {
            for (let r = 0; r < 3; r++)
                for (let c = 0; c < 3; c++) {
                    const top = g[r * 2]?.[c] === '#';
                    const bot = r * 2 + 1 < 5 && g[r * 2 + 1][c] === '#';
                    const chr = top && bot ? '█' : top ? '▀' : bot ? '▄' : '';
                    if (chr)
                        s.put(cx + c, y + r, chr, fg, bg, BOLD);
                }
            cx += 4;
        }
    }
}
/** Draw `text` centered horizontally within [x0, x0+w). */
export function bigCenter(s, y, text, fg, style = 'big', x0 = 0, w = s.w) {
    bigText(s, x0 + Math.max(0, (w - bigWidth(text, style)) >> 1), y, text, fg, style);
}
/** The arcade logo, two rows of half-block lettering. */
export const LOGO = [
    '█   ▄▀█ █▄ █   ▄▀█ █▀█ █▀▀ ▄▀█ █▀▄ █▀▀',
    '█▄▄ █▀█ █ ▀█   █▀█ █▀▄ █▄▄ █▀█ █▄▀ ██▄',
];
