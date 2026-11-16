// Kaomoji-style ASCII emoticons (classic text faces). No modern Unicode emoji
// — these render as plain text so they display identically on every terminal.
// Longest keys are matched first so ':)' doesn't steal from ':-)'.
const ASCII_EMOJI = {
    // happy / excited
    ':)': '( ツ )',
    ':-)': '( ツ )',
    ':]': '( ツ )',
    '=)': '( ツ )',
    ':D': '(╯°□°)╯︵ ┻━┻',
    ':-D': '(╯°□°)╯︵ ┻━┻',
    '=D': '(╯°□°)╯︵ ┻━┻',
    ':p': '(｡◕‿◕｡)',
    ':-p': '(｡◕‿◕｡)',
    ':P': '(｡◕‿◕｡)',
    ':-P': '(｡◕‿◕｡)',
    '=P': '(｡◕‿◕｡)',
    // sad / cry
    ':(': '(╥﹏╥)',
    ':-(': '(╥﹏╥)',
    '=[)': '(╥﹏╥)',
    '=(': '(╥﹏╥)',
    // shock / surprise
    ':O': '(⊙_⊙)',
    ':-O': '(⊙_⊙)',
    ':o': '(⊙_⊙)',
    ':-o': '(⊙_⊙)',
    // wink
    ';)': '(¬‿¬)',
    ';-)': '(¬‿¬)',
    // kiss / love
    ':*': '(｡♥‿♥｡)',
    // neutral / meh
    ':|': '(¬_¬)',
    ':-|': '(¬_¬)',
    // confused
    ':S': '(¬_¬)',
    ':-S': '(¬_¬)',
    ':s': '(¬_¬)',
    ':-s': '(¬_¬)',
};
const ASCII_EMOJI_KEYS = Object.keys(ASCII_EMOJI).sort((a, b) => b.length - a.length);
// Replace ASCII emoticons with kaomoji faces. Longest keys first.
export function asciiEmoji(body) {
    let out = body;
    for (const key of ASCII_EMOJI_KEYS) {
        const re = new RegExp(escapeRegExp(key), 'g');
        out = out.replace(re, ASCII_EMOJI[key]);
    }
    return out;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
