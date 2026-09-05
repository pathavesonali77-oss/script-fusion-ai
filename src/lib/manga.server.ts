import type { Segment } from "./script";
import { pixazoKeys, pickKey } from "./keys.server";
import { geminiChat } from "./gemini.server";

const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";

/**
 * Global art direction — the look of a professionally published full-colour
 * webtoon / manhwa page: crisp clean ink linework, flat cel shading with soft
 * gradient blush and highlights, expressive faces with large detailed eyes,
 * meticulously drawn painted backgrounds (architecture, furniture, props all
 * fully rendered), natural readable colour and light. No mood filter is
 * applied: the lighting is whatever the script line says it is.
 */
export const STYLE =
  "professional full-colour Korean webtoon manhwa art style, masterpiece quality, " +
  "crisp clean confident ink outlines, flat cel shading with soft gradient blush and glossy hair highlights, " +
  "expressive detailed faces with large finely drawn eyes, " +
  "extremely detailed fully rendered background with every piece of architecture, furniture, prop and texture drawn out, " +
  "rich natural colour palette, clear bright readable lighting, sharp focus, intricate details, 8k, best quality";

/**
 * The single authoritative light statement for every panel: natural, faithful
 * to the script, and always readable. Deliberately neutral — no darkness, no
 * mystery, no mood grade.
 */
export const TONE_LOCK =
  "LIGHTING: natural, clear and well-exposed, exactly as the scene describes (bright daylight stays bright, " +
  "a night scene is a well-lit night scene); faces, eyes and every environment detail are fully visible";



/**
 * Flux has NO negative prompt: every noun written here is a token the model can
 * draw. Long "no speech bubbles, no posters, no billboards..." lists were being
 * rendered literally (walls of speech bubbles and signage). So the guards are
 * now short and phrased POSITIVELY wherever possible.
 */
export const NO_TEXT_GUARD =
  "a pure wordless artwork, completely free of any text, lettering, signage, speech balloons or captions";

/** Single-image guard. Deliberately short; see NO_TEXT_GUARD note above. */
export const SINGLE_PANEL_GUARD =
  "one single full-bleed illustration of this one moment, one continuous scene edge to edge, fully drawn and detailed";

/** Added only when the scene has no people in it. */
export const NO_PEOPLE_GUARD =
  "an empty environment shot with no people, no figures and no characters anywhere in frame";

/** Added only when the scene does have named/described people. */
export const CAST_GUARD =
  "only the people described above are present, each drawn once, each with the exact gender stated for them, male characters unmistakably male and female characters unmistakably female, never swapped or blended";

/**
 * Anatomy guard. Panels came back with two figures sharing one shirt and fused
 * torsos, so every body is now explicitly stated to be whole and separate.
 */
export const ANATOMY_GUARD =
  "anatomically correct bodies, one head, two arms and two legs per person, every figure a complete separate body with its own clothing, clearly spaced apart, never fused, merged, overlapping into one another or duplicated";



/**
 * Every text call in the app goes through Gemini (see gemini.server.ts):
 * one key at a time, newest flash model first, automatic switch to the next
 * key when a daily quota runs out.
 */
export async function textChat(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    attempts?: number;
  } = {},
): Promise<string> {
  return geminiChat(user, { system, ...opts });
}

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}


/**
 * Forgiving reader for the prompt-writing answer.
 *
 * The free model kept refusing to emit a strict JSON array (unescaped quotes,
 * trailing prose, half-closed brackets), so the whole chunk was thrown away and
 * no panels ever appeared. The writing step now asks for plain "n) prompt"
 * lines and this parser accepts almost anything shaped like that:
 *
 *   - "1)" / "1." / "1:" / "1 -" / "[1]" / "Prompt 1:" numbering
 *   - leftover bullets, quotes, brackets, commas and code fences
 *   - a stray JSON array (parsed as such when it happens to be valid)
 *   - continuation lines, which are appended to the prompt above them
 *
 * Returns a sparse array indexed by (number - 1). Unnumbered output falls back
 * to reading the non-empty lines in order.
 */
export function parseNumberedList(raw: string, expected: number): string[] {
  const text = stripFences(raw);

  // If the model did return valid JSON after all, take it.
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      const parsed = JSON.parse(text.slice(s, e + 1)) as unknown;
      if (Array.isArray(parsed) && parsed.some((v) => typeof v === "string" && v.length > 30)) {
        return parsed.map((v) => (typeof v === "string" ? clean(v) : ""));
      }
    } catch {
      /* not JSON — fall through to the line reader */
    }
  }

  const out: string[] = [];
  const loose: string[] = [];
  let last = -1;
  const numbered = /^\s*(?:prompt\s*)?[[(]?(\d{1,3})[\])]?\s*[).:\-–—]\s*(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = numbered.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = clean(m[2] ?? "");
      // Guard against a stray number inside prose restarting the list.
      if (n >= 1 && n <= expected + 5) {
        out[n - 1] = body;
        last = n - 1;
        continue;
      }
    }
    if (last >= 0) {
      // Continuation of the previous prompt (the model wrapped a long line).
      out[last] = `${out[last] ?? ""} ${clean(line)}`.trim();
    } else {
      loose.push(clean(line));
    }
  }

  const got = out.filter((v) => v && v.length > 30).length;
  if (got === 0 && loose.length > 0) {
    return loose.filter((v) => v.length > 30);
  }
  return out;
}

/** Strips leftover quoting/bullet punctuation from one recovered prompt. */
function clean(v: string): string {
  return v
    .replace(/^[\s*•\-–—]+/, "")
    .replace(/^["'`“”]+/, "")
    .replace(/["'`“”]?\s*,?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}


/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are the art director of a full-colour webtoon (manhwa) adaptation. Read the WHOLE script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 16-28 words per character. Max 10 characters. " +
    "After the characters, add up to 6 recurring LOCATIONS the same way, one line each, prefixed 'Place - ', with " +
    "fixed visual details (materials, colours, key furniture/landmarks, time of day if fixed) so the same place is " +
    "drawn identically every time it appears, e.g. 'Place - Henan's home: small brick village house, blue wooden " +
    "door, clay-tiled roof, neem tree in the yard, string cot outside'. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary.";

  // Gemini reads a million tokens, so the ENTIRE script goes in — no sampling,
  // no chunking. Characters introduced late are now covered like the rest.
  const body = script.length > MAX_SCRIPT_CHARS ? script.slice(0, MAX_SCRIPT_CHARS) : script;

  try {
    const out = await textChat(system, `FULL SCRIPT:\n${body}`, {
      temperature: 0.4,
      maxOutputTokens: 4_000,
    });
    const bible = stripFences(out).slice(0, 4000);
    if (bible.length > 20) return bible;
  } catch (e) {
    console.error("buildCharacterBible failed, continuing without a bible:", e);
  }
  return "";
}


const PROMPT_SYSTEM =
  "You are the storyboard artist of a richly detailed full-colour webtoon (manhwa) adaptation. You are given a " +
  "character bible and the COMPLETE script (Hindi/Hinglish/English), every line numbered with its timestamp. You are " +
  "then asked for a set of line numbers. For EACH requested number write ONE English image prompt describing a SINGLE " +
  "cinematic moment of exactly that line. You have the whole script, so resolve every place, pronoun and character by " +
  "reading the lines around it.\n" +
  "EVERY prompt must contain, in this order: (1) the location, (2) who is in frame with their bible traits woven inline " +
  "— but ONLY if that line actually involves a person; if it involves none, the shot has no people at all, (3) the exact " +
  "action, body pose and facial expression, (4) 4-6 concrete environmental details, (5) the camera angle and shot size " +
  "(extreme close-up / close-up / medium / wide / low angle / high angle / over-the-shoulder), (6) the natural lighting " +
  "and colour of the scene as the script implies it.\n" +
  "RULES:\n" +
  "- ONE LINE = ONE IMAGE (absolute): exactly one prompt per requested number, in the same order, never merged, never " +
  "split, never skipped, never a placeholder. Each prompt must be visibly DIFFERENT from its neighbours.\n" +
  "- SCRIPT ACCURACY (absolute): the prompt is a literal visual translation of THAT line — the exact subject, action, " +
  "object, place, gesture, emotion, weather and time of day it states. Add nothing the script does not support. If a " +
  "line is inner thought or narration, draw the concrete thing it talks about, in the scene's current location.\n" +
  "- LOCATION LOCK (critical): work out where the story is at that line by reading the earlier lines, open the prompt " +
  "with that place, and stay inside it. Dialogue, whispers, shouts, reactions, memories and thoughts NEVER move the " +
  "scene: only a line that clearly travels somewhere else changes the location.\n" +
  "- CONTINUITY (critical): consecutive lines are consecutive moments of ONE continuous story. Keep the same location " +
  "details, time of day, weather, clothing and props as the previous lines unless the script changes them. Reuse the " +
  "exact wording of the bible's 'Place - ' lines whenever the scene is in that place.\n" +
  "- LIGHTING & COLOUR: take the lighting ONLY from the script — daytime is bright natural daylight, an indoor scene is " +
  "a well-lit room, a night scene is a clearly lit night with visible detail. Never add darkness, gloom, shadowy " +
  "mystery, fog or noir the line does not state. Name the light source and the dominant colours.\n" +
  "- RICH DETAIL (critical): every prompt is dense with concrete visual detail — at least 4-6 specific drawable things " +
  "in the environment; for each person the posture, hand position, exact expression (eyes, eyebrows, mouth) and " +
  "clothing state. Foreground, midground and background must each have something drawn in them.\n" +
  "- Weave a character's fixed traits INLINE (e.g. 'Henan, a thin 17-year-old boy with messy jet-black hair, sits...'). " +
  "NEVER write a separate character description block, sheet, reference, lineup or 'plus portrait of'.\n" +
  "- CONSISTENCY: repeat a character's bible traits (hair, eyes, clothing colours) in EVERY prompt they appear in, using " +
  "the bible's own words. Never redesign, re-age or re-dress a character between shots.\n" +
  "- GENDER ACCURACY (critical): every bible character is written with their name AND their exact gender using an " +
  "explicit gendered noun. Never swap or reverse a character's gender. For side characters, pick one gender from the " +
  "script context and state it explicitly, and keep it identical everywhere in the story.\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): name each person separately with their gender and own distinct traits and " +
  "say where each one stands. Never write 'two figures' or 'the two of them', and never let one character's hair, " +
  "clothing or body type bleed onto the other.\n" +
  "- HEAD COUNT: state explicitly how many people are in frame and that nobody else is present.\n" +
  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets or collages.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "involves no person, the prompt MUST be a pure environment shot with NOBODY in it. Start it with 'Empty environment " +
  "shot, no people:'. Never add a silhouette, an onlooker or the main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd or people running, show that crowd.\n" +
  "- NO TEXT: never describe text, letters, words, numbers, signs, posters, banners, newspapers, book pages, screens " +
  "with writing, labels or logos. Show the OBJECT and the reaction instead, never the writing.\n" +
  "- 90 to 130 words each — dense with visual detail, no filler. English only.\n" +
  "OUTPUT FORMAT (strict about the shape, nothing else): one plain line per requested script line, each starting with " +
  "that script line's own number, then ') ', then the whole prompt on that same single line. Example:\n" +
  "37) In the sunlit courtyard, Henan, a male 17-year-old boy ...\n38) Close-up of ...\n" +
  "No JSON, no quotes, no brackets, no bullets, no headings, no blank lines, and never break one prompt across lines.";


/** Hard ceiling on how much script text is pasted into one request. */
const MAX_SCRIPT_CHARS = 600_000;

/** Numbers the WHOLE script, 1-based, exactly as the model must answer it. */
function numberScript(all: Segment[]): string {
  const text = all.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
  return text.length <= MAX_SCRIPT_CHARS ? text : text.slice(0, MAX_SCRIPT_CHARS);
}

/**
 * Writes image prompts for lines `from`..`to` (1-based, inclusive) while the
 * model reads the ENTIRE script.
 *
 * There is no chunk system any more: Gemini gets the full script and the full
 * character bible on every call, so continuity comes from the model actually
 * seeing the whole story rather than from stitched-together chunk briefs. A
 * pass only limits how many prompts are ASKED FOR at once, because the answer
 * (not the input) is what has a token ceiling.
 */
export async function writePrompts(
  bible: string,
  all: Segment[],
  from: number,
  to: number,
): Promise<string[]> {
  const count = to - from + 1;
  if (count <= 0) return [];
  const script = numberScript(all);

  const ask = async (want: number[], temp: number) => {
    const list = want.join(", ");
    return textChat(
      PROMPT_SYSTEM,
      `CHARACTER BIBLE:\n${bible || "(none)"}\n\n` +
        `FULL SCRIPT (every line is numbered; read all of it for continuity):\n${script}\n\n` +
        `NOW WRITE PROMPTS ONLY FOR THESE LINE NUMBERS: ${list}.\n` +
        `Output exactly ${want.length} lines, each starting with the script line's own number, ` +
        `then ') ', then the prompt. Nothing else.`,
      {
        temperature: temp,
        // ~200 tokens of prompt per line, plus head-room.
        maxOutputTokens: Math.min(60_000, 2_000 + want.length * 320),
      },
    );
  };

  const wanted = Array.from({ length: count }, (_, i) => from + i);
  const byNumber = new Map<number, string>();

  const absorb = (raw: string) => {
    // Answers are numbered with the GLOBAL line number, so the parser is fed
    // the highest expected number and the results re-keyed.
    const parsed = parseNumberedList(raw, all.length);
    parsed.forEach((v, idx) => {
      if (typeof v === "string" && v.trim().length > 30) byNumber.set(idx + 1, v.trim());
    });
  };

  try {
    absorb(await ask(wanted, 0.7));
  } catch (e) {
    console.error("writePrompts pass failed:", e instanceof Error ? e.message : e);
  }

  // Repair pass: one timestamp must always get its own prompt.
  const missing = wanted.filter((n) => !byNumber.has(n));
  if (missing.length > 0) {
    try {
      absorb(await ask(missing, 0.5));
    } catch (e) {
      console.error("writePrompts repair failed:", e instanceof Error ? e.message : e);
    }
  }

  const built = wanted.map((n) => {
    const seg = all[n - 1] as Segment;
    const text = byNumber.get(n) ?? fallbackPrompt(seg);
    return sanitizePrompt(text);
  });

  return chainContinuity(built);
}

/**
 * Panel-to-panel continuity. Consecutive panels are consecutive moments of one
 * continuous story, so the render is told explicitly that only the camera,
 * pose and expression change from one illustration to the next.
 */
export function chainContinuity(prompts: string[]): string[] {
  return prompts.map((p, i) =>
    i === 0
      ? p
      : `${p} Direct visual continuation of the immediately previous illustration in the same story: ` +
        `identical art style, and the same characters with identical faces, hair, clothing and colours; ` +
        `unless this line itself moves the story, also the same place, the same time of day, the same weather ` +
        `and the same props in the same positions — only the camera angle, the pose and the expression change.`,
  );
}


function fallbackPrompt(s: Segment, action?: string): string {
  return (
    "A single richly detailed full-colour webtoon scene in clear natural lighting, with a fully drawn background, " +
    `depicting this exact story moment: ${action ? action : s.text}`
  );
}



/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [/\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi, "weathered wall"],
  [/\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi, "bare wall"],
  // Paper props only when they are the object itself. A trailing noun means the
  // word is an adjective for real furniture ("ticket machine", "note board"),
  // which must be left intact — rewriting it produced nonsense like
  // "a small worn paper object machine on the wall".
  [/\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b(?!\s+(machine|machines|counter|booth|stand|window|holder|dispenser|rack|box|board|shelf|kiosk|gate|barrier|office|hall|desk))/gi, "worn paper object"],
  [/\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi, ""],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [/\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi, "dark glowing screen"],
  // Balloons/lettering furniture: naming them at all makes Flux draw them.
  [/\b(speech|thought|dialogue|word)\s*(bubble|balloon)s?\b/gi, ""],
  [/\b(comic|manga|manhwa|webtoon)\s+(page|panel|panels|strip|layout|gutters?)\b/gi, "illustration"],
  [/\b(says?|saying|shouts?|shouting|whispers?|whispering|yells?|screams?|mutters?|exclaims?)\s*[,:]?\s*["“'][^"”']{0,160}["”']/gi, ""],
  [/"[^"]{0,120}"/g, ""],
  [/'[^']{2,120}'/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/**
 * Metaphor scrubber. "his lungs burned with fire" was rendered LITERALLY —
 * flames erupting from a character's chest. Figurative body/soul imagery is
 * rewritten into the visible human reaction instead.
 */
const METAPHOR_TRIGGERS: [RegExp, string][] = [
  [/\b(lungs?|chest|throat|veins?|blood|body|skin|heart|soul|mind|nerves?)\s+(burning|on fire|aflame|ablaze|engulfed in flames?|filled with fire|searing with fire)\b/gi, "face contorted in pain, hand clutching the chest"],
  [/\b(fire|flames?|embers?|lightning|electricity|energy)\s+(erupting|bursting|pouring|radiating|spreading)\s+(from|out of|through)\s+(his|her|their|the)\s+(chest|body|lungs?|throat|skin|veins?|mouth|eyes)\b/gi, "body tensed, breath sharp, expression strained"],
  [/\b(glowing|luminous|visible|exposed|raw|pulsing)\s+(organs?|flesh|muscle|lungs?|veins?|anatomy|innards?)\b/gi, "strained expression"],
  [/\b(soul|spirit|consciousness|essence)\s+(torn|ripped|wrenched|extracted|pulled|dragged)\s+\w*\s*(from|out of)[^,.]*/gi, "whole body convulsing, eyes wide with shock"],
  [/\b(x-?ray|anatomical cutaway|see-through body|transparent body|internal organs? view)\b/gi, "normal opaque body"],
  [/\b(surreal|symbolic|abstract|metaphorical|dreamlike|otherworldly)\s+(imagery|vision|representation|overlay|effect)s?\b/gi, "grounded realistic depiction"],
];

/**
 * Dark-tone scrubber. The storyboard has no mood filter any more, so any
 * leftover "dim / gloomy / mysterious" phrasing the text model still slips in
 * is rewritten into neutral, well-lit wording. Genuine script facts (night,
 * rain, a candle) are left alone — only the atmosphere adjectives go.
 */
const DARK_TRIGGERS: [RegExp, string][] = [
  [/\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|dim|low[- ]key|chiaroscuro|oppressive|bleak|desaturated|muted)\s+(lighting|light|atmosphere|mood|tone|palette|colou?rs?|shadows?|room|scene|interior|street|corridor)\b/gi, "clear well-lit $2"],
  [/\b(thick|deep|heavy|pitch|near|total|enveloping|swallowing)\s+(darkness|shadow|shadows|gloom|black)\b/gi, "soft natural light"],
  [/\b(in|into|through|from|within|amid)\s+(the\s+)?(darkness|gloom|shadows|murk)\b/gi, "$1 the light"],
  [/\b(hard|harsh|deep|long|heavy|dramatic)\s+shadows?\b/gi, "soft shadows"],
  [/\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|low[- ]key|oppressive|bleak)\b,?\s*/gi, ""],
  [/\b(dark|dim)\s+(and|,)\s+(mysterious|moody|gloomy|eerie)\b/gi, "clearly lit"],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or a dark mood grade. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "full colour",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of METAPHOR_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of DARK_TRIGGERS) out = out.replace(re, to);

  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 6);
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Stamp the gender next to each name so the renderer cannot misread it.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male man" : "female woman";
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\b)`, "g"),
      `${e.name} (${noun})`,
    );
  }

  // With two or more people in frame the renderer tends to blend or swap
  // genders, so state the split explicitly right after the scene text.
  if (present.length >= 2) {
    const males = present.filter((e) => genderOf(e.traits) === "male").map((e) => e.name);
    const females = present.filter((e) => genderOf(e.traits) === "female").map((e) => e.name);
    if (males.length > 0 && females.length > 0) {
      out +=
        `. In this frame ${males.join(" and ")} ${males.length > 1 ? "are" : "is"} clearly MALE ` +
        `(masculine face and body, male hairstyle and male clothing), and ` +
        `${females.join(" and ")} ${females.length > 1 ? "are" : "is"} clearly FEMALE ` +
        `(feminine face and body, female hairstyle and female clothing); do not swap, blend or feminise/masculinise them`;
    }
  }
  return out;
}


function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  let matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  // Pronoun-only beats ("he was lying on the stone") name nobody. Falling back
  // to the FIRST bible entry was drawing the same person (often the elderly
  // woman listed first) into every unnamed panel, including panels about a
  // young man. The fallback now has to agree with the prompt's own gender
  // words, and gives up entirely when nothing matches.
  if (matched.length === 0) {
    const male = /\b(he|him|his|himself|man|men|boy|boys|male|guy|father|brother|son)\b/i.test(prompt);
    const female = /\b(she|her|herself|woman|women|girl|girls|female|lady|mother|sister|daughter)\b/i.test(prompt);
    if (!male && !female) return "";
    const want = male && !female ? "male" : female && !male ? "female" : null;
    if (!want) return "";
    const candidate = entries.find((e) => genderOf(e.traits) === want);
    if (!candidate) return "";
    matched = [candidate];
  }


  return (
    "Fixed character identity (age, gender and appearance must match exactly for every character, " +
    "never swapped, blended, re-aged or changed between shots): " +
    matched
      .map((e) => {
        const g = genderOf(e.traits);
        const traits = e.traits.replace(/\.$/, "");
        const age = ageOf(e.traits);
        const head = g
          ? `${e.name} is a ${g.toUpperCase()} ${g === "male" ? "man/boy" : "woman/girl"} — ${traits}`
          : `${e.name} is ${traits}`;
        return age ? `${head}; ${e.name} is ${age} and must look exactly ${age} in this image, never younger and never older` : head;
      })
      .join("; ") +
    (matched.length >= 2
      ? ". Keep each of these characters visually distinct from the others and give each one exactly the gender and age stated."
      : ".")
  );
}

/**
 * Reads a character's age out of their bible line. Age drift was a top
 * complaint — the same "old lady" came back young in the next panel — so
 * whatever age the bible fixed is restated as an explicit render instruction.
 */
export function ageOf(traits: string): string {
  const t = traits.toLowerCase();
  const num = /\b(\d{1,2})\s*(?:-|\s)?(?:to|–|-)?\s*(\d{1,2})?\s*(?:-|\s)?year[s]?[- ]old\b/.exec(t);
  if (num) {
    return num[2]
      ? `${num[1]}-${num[2]} years old`
      : `exactly ${num[1]} years old`;
  }
  const bands: [RegExp, string][] = [
    [/\b(elderly|old|aged|ancient|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/, "elderly, clearly aged 65 or older, with deeply wrinkled skin, sagging features and grey or white hair"],
    [/\b(middle[- ]aged|forties|fifties|40s|50s)\b/, "middle-aged, clearly 40 to 55, with faint lines on the face"],
    [/\b(young adult|twenties|thirties|20s|30s)\b/, "a young adult in their twenties or thirties"],
    [/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/, "a teenager, clearly 13 to 18"],
    [/\b(child|kid|little (boy|girl)|toddler|infant|baby)\b/, "a young child"],
  ];
  for (const [re, label] of bands) if (re.test(t)) return label;
  return "";
}



/** True when the prompt describes at least one human in frame. */
export function hasPeople(prompt: string, bible?: string): boolean {
  const p = prompt.toLowerCase();
  if (/\bno (people|figures?|characters?|humans?)\b|\bempty environment\b|\bunpopulated\b/.test(p))
    return false;
  if (bible && parseBible(bible).some((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt)))
    return true;
  return /\b(man|men|woman|women|boy|boys|girl|girls|child|children|person|people|crowd|figure|silhouette|soldier|guard|villager|student|teacher|shopkeeper|worker|stranger|face|faces|he|she|they)\b/.test(
    p,
  );
}

export function composeImagePrompt(prompt: string, bible?: string): string {
  const fixed = enforceGender(sanitizePrompt(prompt), bible);
  const peopled = hasPeople(fixed, bible);
  // Character lock only matters when someone is actually in frame.
  const lock = peopled ? characterLock(fixed, bible) : "";
  // Flux weights the earliest tokens most: a short style lead comes first so
  // the webtoon look can never be truncated away, then the detailed scene,
  // then the identity lock, then the (short, positively phrased) guards.
  return (
    `Full-colour webtoon manhwa style illustration, highly detailed: ${fixed}. ` +
    `${lock ? lock + " " : ""}${TONE_LOCK}. ${STYLE}, ${NO_TEXT_GUARD}. ` +
    `${peopled ? `${CAST_GUARD}. ${ANATOMY_GUARD}` : NO_PEOPLE_GUARD}. ${SINGLE_PANEL_GUARD}. ` +
    `16:9 widescreen cinematic framing.`
  );

}

/**
 * Blank-panel rejection.
 *
 * A blank/solid or nearly-empty Flux frame compresses to a few kilobytes and
 * its compressed bytes carry very little entropy, while a real detailed
 * 1024x576 panel never does. Anything suspiciously small, low-entropy, or not
 * an image at all is treated as blank and re-rendered on another key/seed, so
 * no empty panel can reach the encoder.
 */
const MIN_IMAGE_BYTES = 40_000;
/** Shannon entropy (bits/byte) of compressed image data; real art is > 7.5. */
const MIN_ENTROPY = 7.0;

function byteEntropy(buf: Uint8Array): number {
  const counts = new Uint32Array(256);
  const step = Math.max(1, Math.floor(buf.byteLength / 200_000));
  let n = 0;
  for (let i = 0; i < buf.byteLength; i += step) {
    counts[buf[i]!] = counts[buf[i]!]! + 1;
    n++;
  }
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

async function isRealImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < MIN_IMAGE_BYTES) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45;
    if (!isPng && !isJpg && !isWebp) return false;
    // skip the header before measuring entropy of the compressed payload
    return byteEntropy(buf.subarray(Math.min(2048, buf.byteLength >> 2))) >= MIN_ENTROPY;
  } catch {
    // Network hiccup while probing: don't throw away a probably-good panel.
    return true;
  }
}


/** Calls Flux.1 Schnell (free tier) at max quality with automatic retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
): Promise<string> {
  const keys = pixazoKeys();
  const body = composeImagePrompt(prompt, bible).slice(0, 2000);

  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(PIXAZO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": key,
        },
        body: JSON.stringify({
          prompt: body,
          // Quality over speed: the maximum step count Schnell accepts, at the
          // largest 16:9 size the gateway honours (1280x720 is silently
          // rejected; 1344x768 is rendered at that exact size).
          num_steps: 8,
          // a fresh seed each attempt, so a blank frame is never re-rolled identically
          seed: seed + attempt * 977,
          width: 1344,
          height: 768,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { output?: string };
        if (json.output) {
          if (await isRealImage(json.output)) return json.output;
          lastErr = "blank image rejected";
        } else {
          lastErr = "no output url";
        }
      } else {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}

/* ------------------------------------------------------------------ */
/* Post-render review                                                  */
/* ------------------------------------------------------------------ */

const REVIEW_SYSTEM =
  "You are a manhwa storyboard editor. You are given one script line and the image prompt that was rendered for it. " +
  "Judge whether the rendered panel matches the line: correct setting, correct people (right count and gender), " +
  "the action the line describes, no text/speech bubbles, no literal metaphors (no flames, glowing organs, x-ray bodies), " +
  "and no contradiction with the character sheet. " +
  'Reply with exactly "OK" when it matches. Otherwise reply with ONLY a corrected single-paragraph image prompt ' +
  "(no preamble, no quotes, no explanation) that fixes the problem while keeping the same characters, location and continuity.";

/**
 * Re-checks a rendered panel's prompt against its script line. Returns a
 * rewritten prompt when the panel does not match the line, otherwise null.
 */
export async function reviewPanel(
  line: string,
  prompt: string,
  bible?: string,
  slot = 0,
): Promise<string | null> {
  try {
    void slot;
    const out = await textChat(
      REVIEW_SYSTEM,
      (bible ? `CHARACTER SHEET:\n${bible}\n\n` : "") +
        `SCRIPT LINE:\n${line}\n\nRENDERED PROMPT:\n${prompt}`,
      { temperature: 0.3, maxOutputTokens: 800, attempts: 2 },
    );
    const text = stripFences(out).trim();
    if (!text || /^ok\b/i.test(text) || text.length < 40) return null;
    return sanitizePrompt(text.replace(/^["']|["']$/g, "").slice(0, 1200));
  } catch {
    // Review is best-effort: never fail a good panel because the check failed.
    return null;
  }
}

/**
 * Renders a panel, re-checks it against the script line and, when the check
 * finds a problem, rewrites the prompt and regenerates exactly once.
 */
export async function generateCheckedImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
  line?: string,
): Promise<{ url: string; prompt: string; revised: boolean }> {
  const url = await generateImage(prompt, seed, slot, bible);
  if (!line) return { url, prompt, revised: false };
  const fixed = await reviewPanel(line, prompt, bible, slot);
  if (!fixed) return { url, prompt, revised: false };
  try {
    const retry = await generateImage(fixed, seed + 4409, slot, bible);
    return { url: retry, prompt: fixed, revised: true };
  } catch {
    return { url, prompt, revised: false };
  }
}
