// ASCII-based emoticons (classic text smileys) rendered as small ASCII faces.
// Kept intentionally retro — no Unicode/modern emoji.
const ASCII_EMOJI = {
    // happiness
    ':)': '^.^',
    ':-)': '^.^',
    ':]': '^.^',
    '=)': '^.^',
    ':D': '^D^',
    ':-D': '^D^',
    '=D': '^D^',
    ':p': '^P^',
    ':-p': '^P^',
    ':P': '^P^',
    ':-P': '^P^',
    '=P': '^P^',
    // sadness / shock
    ':(': 'T_T',
    ':-(': 'T_T',
    ':[)': 'T_T',
    '=(': 'T_T',
    ':O': 'o_O',
    ':-O': 'o_O',
    ':o': 'o_O',
    ':-o': 'o_O',
    // wink / love / kiss / meh
    ';)': '^;^',
    ';-)': '^;^',
    ':*': '^:*',
    ':-*': '^:*',
    ':|': '-_-',
    ':-|': '-_-',
    // tongue / confused
    ':S': 'o_O',
    ':-S': 'o_O',
    ':s': 'o_O',
    ':-s': 'o_O',
};
const ASCII_EMOJI_KEYS = Object.keys(ASCII_EMOJI).sort((a, b) => b.length - a.length);
// Replace ASCII emoticons with small ASCII faces. Longest keys first so
// ':-)' doesn't get partially matched by ':)'.
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
