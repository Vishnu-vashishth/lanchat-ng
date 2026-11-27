// Things to draw in Doodle Guess, by how hard they are to get across in a
// few dozen terminal pixels.
export const EASY = `apple banana bed bell bird boat bone book bread bus cake candle car carrot cat
chair cheese clock cloud cookie cow crown cup dice dog door duck egg eye fish
flower fork frog ghost glasses hand hat heart house key kite ladder lamp leaf
lemon lion moon mouse mushroom nose octopus owl pencil phone pig pizza rain
rainbow ring robot rocket sandwich shark sheep shoe smile snake snowman sock
spider spoon star sun sword table tent tiger tomato tooth train tree turtle
umbrella whale wheel window zebra balloon cactus crab drum hammer heart igloo
jellyfish penguin scissors skull volcano worm snail bee cherry grapes`;
export const MEDIUM = `airplane anchor astronaut backpack bandage barn battery beach bicycle bridge
broom butterfly camera campfire castle caterpillar chimney compass dinosaur
dolphin dragon elephant envelope feather fireworks flashlight giraffe hamburger
helicopter hourglass kangaroo lighthouse magnet mermaid microphone mountain
ninja parachute peacock pirate popcorn pyramid saturn scarecrow skateboard
spaceship squirrel submarine sunflower teapot telescope tornado tractor
treasure trophy unicorn vampire waterfall windmill wizard ice-cream toothbrush
headphones lighthouse lollipop mailbox map pineapple pumpkin raccoon
rollerskate seahorse skeleton sloth snowflake spiderweb stapler swing
thermometer traffic-light trampoline volcano watermelon witch zipper`;
export const HARD = `alarm-clock avalanche black-hole blueprint bonfire bookworm camouflage catapult
chandelier crossword daydream earthquake electricity fingerprint gravity
handshake hibernate homework hurricane jet-lag karaoke labyrinth lullaby
meditation nightmare origami password quicksand recycle shadow sleepwalking
snowstorm spotlight stopwatch sunburn traffic-jam tsunami vacation wifi
wormhole echo reflection deadline teleport time-travel gossip jealousy
procrastination evolution friendship construction`;
export function words(list) {
    return [...new Set(list.split(/\s+/).filter(Boolean).map((w) => w.replace(/-/g, ' ')))];
}
