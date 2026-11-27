import type { GameDef } from './types.js';
import { snakeGame } from './snake.js';
import { blastGame } from './blast.js';
import { paddleGame } from './paddle.js';
import { doodleGame } from './doodle.js';
import { eightsGame } from './eights.js';

// Every game the arcade offers, in menu order.
export const GAMES: GameDef[] = [snakeGame, blastGame, paddleGame, doodleGame, eightsGame];

export function gameById(id: string): GameDef | undefined {
  return GAMES.find((g) => g.id === id);
}

/** Match a typed name ("snake", "Snake Arena", "sn") to a game. */
export function findGame(query: string): GameDef | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    GAMES.find((g) => g.id === q || g.title.toLowerCase() === q) ??
    GAMES.find((g) => g.id.startsWith(q) || g.title.toLowerCase().startsWith(q)) ??
    GAMES.find((g) => g.title.toLowerCase().includes(q))
  );
}
