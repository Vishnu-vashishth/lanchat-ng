import type { Surface } from './term/canvas.js';
import type { Key } from './term/keys.js';
import type { Rng } from './rng.js';

// The contract every game implements.
//
// Games are host-authoritative: the player who opens a table runs the
// simulation (GameLogic) and pushes each seat a personalized view; every
// player, the host included, draws those views and turns keys into inputs
// (GameClient). Views carry only what that seat may see — a card game never
// sends one player another player's hand.

export type Phase = 'lobby' | 'playing' | 'results';

export interface Player {
  slot: number; // seat index; drives the player's color
  nick: string;
  bot: boolean;
}

export interface SettingDef {
  key: string;
  label: string;
  choices: { v: string | number; label: string }[];
  def?: number; // index of the default choice
}

export type Settings = Record<string, string | number>;

export interface Standing {
  slot: number;
  nick: string;
  score: number;
  detail?: string;
}

/** What the host hands a game when a match starts. */
export interface HostCtx {
  players: Player[];
  settings: Settings;
  /** Smallest terminal among the human players — size the board to fit it. */
  arena: { cols: number; rows: number };
  rng: Rng;
  /** Post a line to every player's event feed. */
  feed(text: string, slot?: number): void;
}

/** Host-side simulation of one match. */
export interface GameLogic {
  /** Fixed simulation step, in ms. */
  readonly tickMs: number;
  tick(): void;
  /** A seat's input, exactly as its client sent it. Validate everything. */
  input(slot: number, data: unknown): void;
  /** JSON-serializable view for a seat; null = spectator. */
  view(slot: number | null): unknown;
  /** A seat left mid-match (quit or disconnected). */
  drop(slot: number): void;
  /** Optional: seat someone who arrives mid-match (party games); return false to make them watch. */
  addPlayer?(p: Player): boolean;
  readonly done: boolean;
  /** Final ranking, best first. */
  standings(): Standing[];
  /** Extra lines for the results screen (records, awards). */
  summary?(): string[];
}

export interface SideLine {
  text: string;
  fg?: number;
  at?: number;
  /** Draw a color swatch for this seat before the text. */
  slot?: number;
}

export interface ViewCtx {
  me: number | null; // my seat, null when spectating
  players: Player[];
  nick(slot: number): string;
  color: boolean;
  now: number; // local clock (ms) for blinking and animation
}

/** Client-side half: draws views and maps keys to inputs. */
export interface GameClient {
  /** Board size (cells) for this frame within the space offered, or null if it cannot fit. */
  measure(frame: unknown, availW: number, availH: number): { w: number; h: number } | null;
  /** Minimum terminal area this frame needs, for the "terminal too small" hint. */
  need(frame: unknown): { w: number; h: number };
  draw(s: Surface, frame: unknown, ctx: ViewCtx): void;
  /** Turn a key into input for the host (undefined = nothing to send). */
  key(k: Key, frame: unknown, ctx: ViewCtx): unknown;
  help(frame: unknown, ctx: ViewCtx): string;
  status?(frame: unknown, ctx: ViewCtx): string;
  scoreboard?(frame: unknown, ctx: ViewCtx): SideLine[];
  /** When non-null, typed text goes to a box with this label instead of chat. */
  prompt?(frame: unknown, ctx: ViewCtx): string | null;
  submit?(text: string, frame: unknown, ctx: ViewCtx): unknown;
}

export interface GameDef {
  id: string;
  title: string;
  tag: string; // one-line pitch
  genre: string; // 'real-time' | 'party' | 'cards'
  min: number;
  max: number;
  bots: boolean;
  about: string;
  controls: string[];
  art: string[]; // small preview for the arcade menu
  accent: number; // header color
  settings: SettingDef[];
  create(ctx: HostCtx): GameLogic;
  client(): GameClient;
}
