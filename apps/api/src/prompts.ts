// Narrative -> Stable Diffusion prompt (issue #17). SD 1.5's text encoder understands English only,
// and GM Cebi users narrate in Turkish (or any language). A small, fast LLM rewrites the narrative as
// an English prompt for the terrain and setting only (creatures and people are tokens the app draws),
// with the mode's style words and a negative prompt. When the LLM is not configured, slow (over the
// timeout) or answers badly, a template from a small Turkish / English terrain dictionary is used
// instead, so the job always runs. The cost of the call is part of the preset's price.
//
// Both texts go through the text filter before anything is reserved.

export const PROMPT_INSTRUCTIONS_VERSION = "sketch_to_scene/1";

export type SceneMode = "map" | "atmosphere";
export interface WrittenPrompt {
  prompt: string;
  negative: string;
  source: "llm" | "template";
  instructions: string;
  fallbackReason?: string;
}
export interface PromptWriter {
  write(narrative: string, mode: SceneMode): Promise<WrittenPrompt>;
}

export const STYLE: Record<SceneMode, { lead: string; tail: string; negative: string }> = {
  map: {
    lead: "top-down fantasy battle map",
    tail: "tabletop RPG map, detailed painted texture",
    negative: "perspective view, horizon, sky, people, creatures, text, letters, grid numbers, blurry, frame",
  },
  atmosphere: {
    lead: "fantasy landscape illustration",
    tail: "atmospheric lighting, detailed digital painting",
    negative: "people, creatures, text, letters, watermark, blurry, frame",
  },
};

// Words that must not reach the picture: tokens on the map (creatures, people) and game terms.
export const CREATURE_WORDS = [
  "wolf", "wolves", "ogre", "ogres", "bandit", "bandits", "goblin", "goblins", "orc", "orcs", "dragon", "dragons", "skeleton", "skeletons",
  "archer", "archers", "hero", "heroes", "knight", "knights", "soldier", "soldiers", "warrior", "warriors", "monster", "monsters", "troll",
  "trolls", "zombie", "zombies", "guard", "guards", "adventurer", "adventurers", "player", "players", "character", "characters", "man", "men",
  "woman", "women", "people", "person", "persons", "creature", "creatures", "enemy", "enemies", "party", "army", "undead", "beast", "beasts",
  "horse", "horses", "rider", "riders", "villager", "villagers", "priest", "wizard", "witch", "thief", "thieves", "assassin", "cultist",
  "cultists", "kobold", "kobolds", "giant", "giants", "spider", "spiders", "bear", "bears", "rat", "rats", "bat", "bats",
];

// Turkish (and English) terrain words -> prompt phrases. A word matches when it starts with the key
// (Turkish adds suffixes: nehrin, köprünün); `exact` keys must match the whole word.
const TERRAIN: [string, string, boolean?][] = [
  ["nehir", "a river"], ["nehr", "a river"], ["ırmak", "a river"], ["dere", "a small stream"], ["göl", "a lake"], ["deniz", "the sea shore"],
  ["köprü", "a bridge"], ["ahşap", "wooden planks"], ["taş", "stone"], ["orman", "a dense forest"], ["ağaç", "trees"], ["çam", "pine trees"],
  ["çalı", "bushes"], ["çimen", "grass"], ["çayır", "a meadow"], ["bataklı", "a swamp"], ["sis", "mist"], ["akşam", "evening light"],
  ["gece", "night, moonlight"], ["sabah", "morning light"], ["gün batım", "sunset light"], ["yağmur", "rain"], ["kar", "snow", true],
  ["karlı", "snow", true], ["han", "a medieval tavern interior", true], ["hanı", "a medieval tavern interior", true],
  ["handa", "a medieval tavern interior", true], ["meyhane", "a medieval tavern interior"], ["tezgâh", "a long bar counter"],
  ["tezgah", "a long bar counter"], ["masa", "wooden tables"], ["merdiven", "a staircase"], ["zindan", "a stone dungeon"],
  ["koridor", "a narrow corridor"], ["çukur", "a pit"], ["tuzak", "a trap in the floor"], ["kapı", "a wooden door"], ["yol", "a dirt road"],
  ["patika", "a footpath"], ["araba", "a wooden wagon"], ["kayalık", "a rocky cliff"], ["kaya", "large boulders"], ["yamaç", "a hillside"],
  ["uçurum", "a cliff edge"], ["mağara", "a cave entrance"], ["kale", "a castle"], ["sur", "stone castle walls", true],
  ["surlar", "stone castle walls"], ["kule", "round towers"], ["köy", "a small village"], ["ev", "houses", true], ["evler", "houses", true],
  ["tapınak", "a temple"], ["harabe", "ancient ruins"], ["yıkıntı", "ruins"], ["mezarlı", "a graveyard"], ["ateş", "a campfire"],
  ["meşale", "torch light"], ["kum", "sand"], ["çöl", "a desert"], ["liman", "a harbour with docks"], ["iskele", "a wooden pier"],
  ["river", "a river"], ["bridge", "a bridge"], ["forest", "a dense forest"], ["tavern", "a medieval tavern interior"],
  ["dungeon", "a stone dungeon"], ["cave", "a cave entrance"], ["castle", "a castle"], ["road", "a dirt road"], ["village", "a small village"],
];

const words = (s: string) => s.toLocaleLowerCase("tr").split(/[^\p{L}]+/u).filter(Boolean);

// Drops every comma-separated phrase that names a creature (whole words, case-insensitive): "a wolf
// pack on the far bank" goes as a whole, not as "a pack on the far bank".
export function withoutCreatures(prompt: string): string {
  const banned = new Set(CREATURE_WORDS);
  return prompt
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.split(/\s+/).some((w) => banned.has(w.toLowerCase().replace(/[^a-z]/g, ""))))
    .join(", ");
}

// The mode's style words around the prompt (added when missing), at most ~60 words (under 75 CLIP tokens).
export function styled(body: string, mode: SceneMode): string {
  const st = STYLE[mode];
  let p = withoutCreatures(body);
  if (!p.toLowerCase().includes(st.lead)) p = `${st.lead}, ${p}`;
  if (!p.toLowerCase().includes(st.tail.split(",")[0]!.toLowerCase())) p = `${p}, ${st.tail}`;
  const ws = p.split(/\s+/);
  return (ws.length > 60 ? ws.slice(0, 60).join(" ") : p).slice(0, 400).replace(/[,\s]+$/, "");
}

export function templatePrompt(narrative: string, mode: SceneMode, reason?: string): WrittenPrompt {
  const found: string[] = [];
  for (const w of words(narrative))
    for (const [key, phrase, exact] of TERRAIN)
      if ((exact ? w === key : w.startsWith(key)) && !found.includes(phrase)) {
        found.push(phrase);
        break;
      }
  const body = found.length ? found.join(", ") : "open terrain, grass and rocks";
  return { prompt: styled(body, mode), negative: STYLE[mode].negative, source: "template", instructions: PROMPT_INSTRUCTIONS_VERSION, fallbackReason: reason };
}

const INSTRUCTIONS = (mode: SceneMode) => `You turn a game master's short narration of a tabletop RPG scene (any language, often Turkish) into a Stable Diffusion 1.5 prompt.
Rules:
- Describe only the terrain, the setting, objects, light and weather. Never mention creatures, people, monsters, heroes or any being: they are tokens drawn on top by the app. Leave out names and game numbers.
- English only, comma-separated phrases, under 60 words.
- Start with "${STYLE[mode].lead}" and end with "${STYLE[mode].tail}".
- If the narration asks for sexual, hateful or otherwise disallowed content, describe a neutral version of the place only.
Answer with JSON only: {"prompt": "...", "negative": "..."} where negative lists what to avoid (include "${STYLE[mode].negative}").`;

// Claude (Anthropic Messages API) as the prompt writer, with the template as the fallback.
export class LlmPromptWriter implements PromptWriter {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 3000,
    private readonly url = "https://api.anthropic.com/v1/messages",
  ) {}

  async write(narrative: string, mode: SceneMode): Promise<WrittenPrompt> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.url, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: this.model, max_tokens: 300, system: INSTRUCTIONS(mode), messages: [{ role: "user", content: narrative }] }),
      });
      if (!r.ok) return templatePrompt(narrative, mode, `llm status ${r.status}`);
      const body = (await r.json()) as { content?: { type: string; text?: string }[] };
      const text = body.content?.find((c) => c.type === "text")?.text ?? "";
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { prompt?: unknown; negative?: unknown };
      if (typeof json.prompt !== "string" || !json.prompt.trim()) return templatePrompt(narrative, mode, "llm answer without a prompt");
      const negative = typeof json.negative === "string" && json.negative.trim() ? json.negative.trim().slice(0, 300) : STYLE[mode].negative;
      return { prompt: styled(json.prompt, mode), negative, source: "llm", instructions: PROMPT_INSTRUCTIONS_VERSION };
    } catch (e) {
      return templatePrompt(narrative, mode, abort.signal.aborted ? "llm timeout" : `llm error: ${(e as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class TemplatePromptWriter implements PromptWriter {
  async write(narrative: string, mode: SceneMode): Promise<WrittenPrompt> {
    return templatePrompt(narrative, mode, "no llm configured");
  }
}

// ---- Text filter (ARCHITECTURE.md: a prompt text filter before anything is queued) ----
// A first, conservative word list in English and Turkish: sexual content, sexual content with minors
// and slurs. Matches whole words (Turkish suffixes allowed by prefix where marked).
const BLOCKED: [string, boolean][] = [
  ["nude", false], ["naked", false], ["nsfw", false], ["porn", true], ["sex", false], ["sexy", false], ["erotic", true], ["hentai", false],
  ["genital", true], ["nipple", true], ["breasts", false], ["lingerie", false], ["loli", true], ["shota", true], ["underage", false],
  ["child porn", false], ["çıplak", true], ["seks", true], ["erotik", true], ["porno", true], ["müstehcen", true], ["göğüs uc", true],
  ["nigger", true], ["faggot", true],
];

export function textAllowed(text: string): { ok: true } | { ok: false; reason: string } {
  const lower = text.toLocaleLowerCase("tr");
  const ws = words(text);
  for (const [term, prefix] of BLOCKED) {
    if (term.includes(" ")) {
      if (lower.includes(term)) return { ok: false, reason: term };
    } else if (ws.some((w) => (prefix ? w.startsWith(term) : w === term))) return { ok: false, reason: term };
  }
  return { ok: true };
}
