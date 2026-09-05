import type { Segment } from "./script";
import { paralonKeys, pixazoKeys, pickKey } from "./keys.server";
import { acquire, acquireBestKey } from "./rate-limit.server";

export const CHAT_URL = "https://paraloncloud.com/v1/chat/completions";
/** Free-tier model only — the Paralon keys carry no credits. */
export const CHAT_MODEL = "qwen3.8-27b";
/** Measured Paralon free-tier quota: 5 requests per minute, per key. */
export const PARALON_RPM = 5;
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



export async function zaiChat(
  messages: { role: string; content: string }[],
  opts: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    attempts?: number;
    /** Scene/batch index — spreads concurrent calls over the key pool. */
    slot?: number;
  } = {},
): Promise<string> {
  const keys = paralonKeys();

  const attempts = opts.attempts ?? 4;
  let lastErr = "";
  let lastKey: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // MEASURED LIMIT: the provider allows 5 requests per minute PER KEY. Waves
    // of parallel calls used to spend the whole minute collecting 429s, which
    // looked like the run hanging at "prompts 0/N". The scheduler now waits for
    // a genuinely free slot on the least-busy key before every request.
    const key = await acquireBestKey(keys, PARALON_RPM, lastKey);
    lastKey = key;
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Free model only: the keys hold zero credits, so never fall back
          // to a paid model.
          model: opts.model ?? CHAT_MODEL,
          temperature: opts.temperature ?? 0.6,
          // Disable Qwen3 thinking/reasoning mode so the model answers directly
          // and returns much faster. vLLM reads it from chat_template_kwargs;
          // the flat flag is kept for gateways that look at the top level.
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: opts.maxTokens ?? 4000,
          messages,
        }),
      });
      if (!res.ok) {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        // 401/403 = bad key, 400 = the request itself (usually too long) — both
        // are pointless to retry on the same payload.
        if (res.status === 400 || res.status === 401 || res.status === 403) break;
        // 429 means our local window drifted from the provider's: burn this
        // key's remaining quota so the scheduler moves on to another one.
        if (res.status === 429) {
          for (let i = 0; i < PARALON_RPM; i++) await acquire(key, PARALON_RPM);
          continue;
        }
      } else {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning?: string } }[];
        };
        const msg = json.choices?.[0]?.message;
        const text = msg?.content?.trim() || extractFromReasoning(msg?.reasoning);
        if (text) return text;
        lastErr = "empty completion";
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // 502/504 come from the provider's edge (HTML body), not the model:
    // back off progressively instead of failing the whole batch.
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }


  throw new Error(`Text model request failed: ${lastErr}`);
}

/** Last-resort salvage: pull a JSON array out of truncated reasoning text. */
function extractFromReasoning(reasoning?: string): string | null {
  if (!reasoning) return null;
  const start = reasoning.indexOf("[");
  const end = reasoning.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const slice = reasoning.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return Array.isArray(parsed) ? slice : null;
  } catch {
    return null;
  }
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
    "You are the art director of a full-colour webtoon (manhwa) adaptation. Read the script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 16-28 words per character. Max 6 characters. " +
    "After the characters, add up to 4 recurring LOCATIONS the same way, one line each, prefixed 'Place - ', with " +
    "fixed visual details (materials, colours, key furniture/landmarks, time of day if fixed) so the same place is " +
    "drawn identically every time it appears, e.g. 'Place - Henan's home: small brick village house, blue wooden " +
    "door, clay-tiled roof, neem tree in the yard, string cot outside'. " +
    "You are given only the OPENING of the script; that is enough — do not ask for more. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary. Do not deliberate — answer immediately.";

  // Sampled across the WHOLE script (opening + middle + end), not just the
  // head: in an hour-long script most characters are introduced long after the
  // first scenes, and any character missing from the bible got no fixed look.
  const sampleAt = (budget: number) => {
    if (script.length <= budget) return script;
    const slice = (from: number, len: number) => {
      const raw = script.slice(from, from + len);
      const start = from === 0 ? 0 : raw.indexOf("\n") + 1;
      const cut = raw.lastIndexOf("\n");
      return raw.slice(start, cut > len * 0.5 ? cut : undefined);
    };
    const part = Math.floor(budget / 3);
    return [
      slice(0, part),
      slice(Math.floor(script.length / 2) - part / 2, part),
      slice(Math.max(0, script.length - part), part),
    ]
      .filter(Boolean)
      .join("\n...\n");
  };

  let lastErr = "";
  // shrink on every failure: context overflow is the usual cause for long scripts
  for (const [i, budget] of [6000, 4000, 2500, 1200].entries()) {
    try {
      const out = await zaiChat(
        [
          { role: "system", content: system },
          { role: "user", content: `SCRIPT SAMPLES (start, middle, end):\n${sampleAt(budget)}` },
        ],

        { maxTokens: 1200, timeoutMs: 180_000, attempts: 2, slot: i },
      );
      const bible = stripFences(out).slice(0, 2400);
      if (bible.length > 20) return bible;
      lastErr = "empty bible";

    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("buildCharacterBible failed, continuing without a bible:", lastErr);
  return "";
}


const PROMPT_SYSTEM =
  "You write image prompts for a richly detailed full-colour webtoon (manhwa) storyboard. Input: a character bible, " +
  "optional story context, and numbered script lines (Hindi/Hinglish). For EACH numbered line write ONE English image " +
  "prompt describing a SINGLE cinematic moment from that line.\n" +
  "EVERY prompt must contain, in this order: (1) who is in frame with their bible traits woven inline — but ONLY if the " +
  "script line actually mentions a person; if it mentions none, this part is skipped entirely and the shot has no people " +
  "at all, (2) the exact action, body pose and facial expression, (3) the specific setting with 4-6 concrete environmental " +
  "details taken from the script line and the bible's place description, (4) the camera angle and shot size (extreme " +
  "close-up / close-up / medium / wide / low angle / high angle / over-the-shoulder), (5) the natural lighting and colour " +
  "of the scene as the script implies it (e.g. 'bright morning sunlight, blue sky, green fields', 'warm ceiling lamp " +
  "light, cream walls', 'clear moonlit night with visible detail').\n" +

  "RULES:\n" +
  "- ONE LINE = ONE IMAGE (absolute): the output array has EXACTLY one prompt per numbered line, in the same order, even " +
  "when consecutive lines are similar. Never merge two lines, never split one line into two, never skip a line, never " +
  "return a placeholder. Each prompt must be visibly DIFFERENT from its neighbours (different action, framing or " +
  "expression) because each one becomes its own image.\n" +
  "- SCRIPT ACCURACY (absolute): the prompt must be a literal visual translation of THAT line's content — the exact " +
  "subject, action, object, place, gesture, emotion, weather and time of day the line states. If the line states a " +
  "detail that can be drawn, it must appear in the prompt. Add nothing the line and brief do not support: no invented " +
  "props, events, people, animals or settings. If a line is inner thought or narration, draw the concrete thing it " +
  "talks about (the person, place or object) in the beat's LOCATION, not a symbolic or unrelated image.\n" +
  "- CHUNK + TIMESTAMP (critical): each prompt is written for ONE numbered timestamp, but grounded in the CHUNK BRIEF. " +
  "Take the place, lighting, objects and cast from the brief's SETTING/OBJECTS/LIGHT/CAST, then apply the per-line BEAT " +
  "and the exact words of that timestamp's line. A prompt must never contradict the brief, and must never copy another " +
  "timestamp's action.\n" +

  "- LOCATION LOCK (critical): every BEAT line starts with 'LOCATION: <place>'. The prompt for that numbered line MUST " +
  "OPEN with that exact place, worded the same way (e.g. 'In the damp stone dungeon cell, ...'), and the rest of the " +
  "prompt must stay inside it. You are FORBIDDEN from inventing, substituting or drifting to any other place — no city " +
  "street, market, jungle, forest, school, office or rooftop unless that is the beat's own LOCATION. Dialogue, " +
  "whispers ('फुसफुसाया'), shouts, reactions, memories and thoughts NEVER move the scene: keep the beat's LOCATION " +
  "and change only the camera, expression and framing. Only a beat whose own LOCATION differs may show a new place.\n" +

  "- FAITHFUL DETAIL (critical): the prompt must capture the specific things that line actually says — the object, the " +
  "place, the gesture, the emotion, the weather, the time of day. Never write a generic 'a boy stands thinking' prompt. " +
  "Do not skip story details; if the line has several details, include the most visual ones.\n" +
  "- LIGHTING & COLOUR: take the lighting ONLY from the script — daytime is bright natural daylight, an indoor scene " +
  "is a well-lit room, a night scene is a clearly lit night with visible detail. Never add darkness, gloom, shadowy " +
  "mystery, fog, noir or dim moody atmosphere that the line does not state. Name the light source and the dominant " +
  "colours of the scene (e.g. 'warm afternoon sun through a window, cream walls, wooden floor').\n" +
  "- RICH DETAIL (critical): every prompt must be dense with concrete visual detail — for the environment name at least " +
  "4-6 specific drawable things (furniture, architecture, textures, props, plants, weather, ground surface) that fit the " +
  "script's location; for each person describe posture, hand position, exact expression (eyes, eyebrows, mouth) and " +
  "clothing state. Foreground, midground and background must each have something drawn in them. A reader must be able " +
  "to tell exactly where the scene is and what is happening from the image alone.\n" +
  "- CONTINUITY (critical): consecutive prompts are consecutive moments of ONE continuous story. Keep the same location " +
  "details, the same time of day, the same weather, the same clothing and the same props from the previous line unless " +
  "the script changes them. Reuse the exact wording of the bible's 'Place - ' lines whenever the scene is in that place.\n" +

  "- Weave a character's fixed traits INLINE into the sentence (e.g. 'Henan, a thin 17-year-old boy with messy jet-black " +
  "hair, sits...'). NEVER write a separate character description block, character sheet, reference, lineup, or 'plus portrait of'.\n" +
  "- CONSISTENCY: repeat a character's bible traits (hair, eyes, clothing colours) in EVERY prompt they appear in, using " +
  "the same words as the bible. Never redesign, re-age or re-dress a character between shots.\n" +
  "- GENDER ACCURACY (critical): every main character from the bible MUST be written with their name AND their exact " +
  "gender from the bible, using an explicit gendered noun — e.g. 'Henan, a male 17-year-old boy...' or 'Priya, a female " +
  "14-year-old girl...'. Never refer to a main character as just 'a man', 'a woman', 'a person', 'he' or 'she' without the " +
  "name. NEVER change, swap or reverse any character's gender. For side characters not in the bible, pick one gender from " +
  "the script context and state it explicitly (e.g. 'a female boss in her 40s, dark business suit').\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): when a prompt shows more than one character, name each one separately with " +
  "their gender and their own distinct traits, and say where each stands (e.g. 'Henan, a male 17-year-old boy with messy " +
  "jet-black hair, on the left, facing Priya, a female 14-year-old girl with a long braid, on the right'). Never write a " +
  "shared description like 'two figures' or 'the two of them', never let one character's hair, clothing or body type bleed " +
  "onto the other, and never render a male character with feminine features or a female character with masculine features.\n" +

  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets, collages or " +
  "side-by-side views.\n" +
  "- WHO LOCK (critical): every BEAT line contains 'WHO: <names>'. That list is the ONLY cast allowed in that prompt — " +
  "no one else may appear, not even the main character. If WHO says 'no people', the prompt MUST be a pure environment " +
  "shot with nobody, no silhouette and no distant figure. If WHO names a side character, draw THAT side character (with " +
  "their look from the brief's CAST), never the protagonist.\n" +
  "- PRONOUNS (critical): Hindi pronouns (वो, वह, उसने, उसके, उसकी, इसने, उन्होंने) refer to whoever the BEAT's WHO " +
  "names — resolve them through the WHO list, never default to the main character. If the previous line was about a " +
  "side character, 'उसने' is that side character.\n" +
  "- CAST FIDELITY: include ONLY the people in WHO, each drawn once. Never assume two characters are together unless " +
  "WHO lists both.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "names NO person by name or pronoun, the prompt MUST be a pure environment shot with NOBODY in it. Start it with " +
  "'Empty environment shot, no people:' and describe only the place/object/phenomenon, its scale, atmosphere and " +
  "lighting. Never add a silhouette, a lone figure, an onlooker or the main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd, people running or panicking, then the prompt MUST show " +
  "that crowd (many varied ordinary people, their expressions and motion) — do not reduce it to one person.\n" +
  "- SIDE CHARACTERS: if WHO names someone NOT in the bible (a boss, teacher, shopkeeper), use the short distinct " +
  "visual the brief's CAST gives them (age, gender, one clothing detail). NEVER substitute a main character's name or " +
  "traits for a side character.\n" +
  "- STRICT FIDELITY: describe ONLY what the script line actually says. Never invent people, animals, vehicles or crowds " +
  "the line does not mention. If the line names no location, keep the background a simple dark neutral space.\n" +


  "- NO TEXT: never describe text, letters, words, numbers, signs, signboards, posters, banners, newspapers, book pages, " +
  "screens with writing, labels or logos. If the script mentions something written, show the OBJECT and the character's " +
  "reaction instead, never the writing itself.\n" +
  "- 90 to 130 words each — dense with visual detail, no filler. English only.\n" +
  "- Do not deliberate or explain. Start writing the numbered lines immediately.\n" +
  "OUTPUT FORMAT (strict about the shape, nothing else): write one plain line per numbered script line, " +
  "in the same order, each starting with its number, then ') ', then the prompt on that same single line. " +
  "Example:\n1) In the sunlit courtyard, Henan, a male 17-year-old boy ...\n2) Close-up of ...\n" +
  "No JSON, no quotes, no brackets, no bullet points, no headings, no blank lines between them, " +
  "and never break one prompt across two lines.";


const CHUNK_SYSTEM =
  "You are a webtoon (manhwa) art director. You are given a character bible, the story so far, and one CHUNK of consecutive " +
  "script lines (Hindi/Hinglish) with timestamps. Analyse ONLY this chunk and return a compact English CHUNK BRIEF " +
  "that a storyboard artist will use to draw every line of this chunk.\n" +
  "Return plain text with exactly these labelled lines:\n" +
  "SETTING: the place(s) this chunk happens in, with 5-8 concrete visual details (architecture, materials, colours, " +
  "furniture, objects, plants, weather, time of day). If the bible has a matching 'Place - ' line, reuse its details verbatim.\n" +
  "CAST: only the people who actually appear in this chunk, each with their fixed traits (from the bible if listed there, " +
  "otherwise invent a short fixed look: age, gender, hair, clothing colour). ALWAYS state each person's gender " +
  "explicitly as 'male' or 'female' with a matching noun, identical every time that person appears in the story. " +
  "Write 'none' if the chunk has no people.\n" +
  "OBJECTS: the specific things/phenomena the chunk mentions (gates, storm, letter, vehicle...) and how they look.\n" +
  "LIGHT: the natural lighting and colour of this chunk exactly as the script implies (time of day, light source, sky, " +
  "dominant colours) — factual only, never add gloom, darkness or mystery the script does not state.\n" +
  "BEATS: one short line per numbered script line, in this exact format — 'n) LOCATION: <the place this shot happens " +
  "in, 3-6 words> | WHO: <exact character names visible in this shot, comma separated, or 'no people'> | <what visibly " +
  "happens>'.\n" +
  "LOCATION rules: it must stay the SAME for every line of the chunk unless the script line itself clearly moves the " +
  "scene somewhere else (a stated new place, a door opened, a journey). Dialogue, whispering, reactions and thoughts " +
  "NEVER change the location.\n" +
  "WHO rules (critical): resolve every Hindi pronoun (वो, वह, उसने, उसके, उसकी, इसने, उन्होंने, वे) to the ACTUAL " +
  "character it refers to by reading the surrounding lines of this chunk and the story so far — it is very often a SIDE " +
  "character, not the protagonist. Never write the protagonist's name unless that line truly shows him. Write the " +
  "resolved names only (e.g. 'WHO: Marie' or 'WHO: Marie, the team captain'). If the line names no person by noun and " +
  "no pronoun refers to a person — a place, sky, object, weather, phenomenon or narration about the world — write " +
  "exactly 'WHO: no people'. For unnamed masses write 'WHO: crowd'. Do NOT add any human to a line that has none.\n" +
  "GENDER rule (critical): after each name in WHO, add its gender in brackets, e.g. 'WHO: Henan (male), Priya (female)'. " +
  "Use the bible/CAST gender and keep it identical for that character in every beat of every chunk.\n" +
  "STATE: the LAST line of your answer must be a single handover line for the next chunk, in this exact format — " +
  "'STATE: PLACE: <the place the chunk ends in, worded exactly as in the BEATS> | TIME: <time of day> | " +
  "WEATHER: <weather/sky> | WEARING: <each present character and the clothes they are currently in> | " +
  "PROPS: <objects still in the scene> | WITH: <who is together in the scene right now>'. " +
  "If a STORY SO FAR / CONTINUITY STATE was given to you, you MUST start from it: the first beat of this chunk " +
  "continues in that same PLACE, TIME, WEATHER and clothing unless a script line in this chunk clearly changes it.\n" +
  "Be specific and faithful to the script. No commentary, no headings other than the labels above. Answer immediately.";




/**
 * Reads one chunk of the script and returns a brief (setting, cast present,
 * objects, mood, per-line beats). Written before the chunk's prompts so every
 * panel in the chunk shares the same analysed context — this is what keeps
 * detail and continuity inside a chunk.
 */
export async function analyzeChunk(
  bible: string,
  segments: Segment[],
  slot = 0,
  context = "",
): Promise<string> {
  const numbered = segments.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
  try {
    const out = await zaiChat(
      [
        { role: "system", content: CHUNK_SYSTEM },
        {
          role: "user",
          content:
            `CHARACTER BIBLE:\n${bible}\n\n` +
            (context ? `STORY SO FAR:\n${context}\n\n` : "") +
            `CHUNK SCRIPT LINES:\n${numbered}`,
        },
      ],
      {
        temperature: 0.4,
        maxTokens: 500 + segments.length * 100,
        timeoutMs: 180_000,
        attempts: 2,
        slot,
      },
    );
    return stripFences(out).slice(0, 6000);
  } catch (e) {
    console.error("analyzeChunk failed:", e instanceof Error ? e.message : e);
    return "";
  }
}

/**
 * Writes one image prompt per segment, in batches.
 *
 * `context` carries the chunk brief plus the script lines immediately before
 * this chunk so the model knows where the scene is and who is present — that
 * continuity is what stops panels from losing story detail at chunk boundaries.
 */

export async function writePrompts(
  bible: string,
  segments: Segment[],
  slot = 0,
  context = "",
  brief = "",
): Promise<string[]> {
  const numbered = segments.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");

  const ask = async (segs: Segment[], lines: string, s: number, temp: number) =>
    zaiChat(
      [
        { role: "system", content: PROMPT_SYSTEM },
        {
          role: "user",
          content:
            `CHARACTER BIBLE:\n${bible}\n\n` +
            (context ? `STORY SO FAR (context only — do NOT storyboard these):\n${context}\n\n` : "") +
            (brief
              ? `CHUNK BRIEF (analysis of exactly these lines — obey its SETTING, CAST, OBJECTS, LIGHT and per-line BEATS; ` +
                `never add a person the BEATS call 'no people'):\n${brief}\n\n`
              : "") +
            `SCRIPT LINES:\n${lines}\n\nWrite exactly ${segs.length} numbered prompt lines, ` +
            `numbered 1 to ${segs.length}, one per script line above, in order. Plain text only.`,

        },
      ],

      {
        temperature: temp,
        maxTokens: 500 + segs.length * 320,
        // Small batches answer in a few seconds; a call that hangs longer is
        // stuck, so fail over to another key instead of blocking the wave.
        timeoutMs: 180_000,
        attempts: 3,
        slot: s,
      },
    );

  let arr: unknown[] = [];
  try {
    // Lenient plain-line format: strict JSON was being refused by the free
    // model, which threw away every prompt in the chunk.
    arr = parseNumberedList(await ask(segments, numbered, slot, 0.7), segments.length);
  } catch (e) {
    console.error("writePrompts first pass failed:", e instanceof Error ? e.message : e);
    arr = [];
  }

  const usable = (v: unknown) => typeof v === "string" && v.trim().length > 30;

  // Repair pass: one timestamp must always get its own prompt, so anything the
  // first pass dropped or truncated is asked for again on a different key.
  const missing = segments.map((_, i) => i).filter((i) => !usable(arr[i]));
  if (missing.length > 0) {
    try {
      const subset = missing.map((i) => segments[i]!);
      const lines = subset.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
      const fixed = parseNumberedList(await ask(subset, lines, slot + 1, 0.5), subset.length);
      missing.forEach((segIdx, k) => {
        if (usable(fixed[k])) arr[segIdx] = fixed[k];
      });

    } catch (e) {
      console.error("writePrompts repair failed:", e instanceof Error ? e.message : e);
    }
  }

  // Beat data, then gap-filled: a beat the analysis left without a LOCATION or
  // WHO inherits the previous beat's, so a missing line can never restart the
  // scene somewhere else or hand the shot to the wrong character.
  const locations = carryForward(parseBeatLocations(brief), segments.length);
  const casts = carryForward(parseBeatCast(brief), segments.length);
  const actions = parseBeatActions(brief);
  const state = parseState(brief);
  const chunkCast = parseCastBlock(brief);

  // One timestamp = one image: the returned array is always exactly as long as
  // `segments`, in the same order, with a fallback prompt rather than a hole.
  const built = segments.map((s, i) => {
    const v = arr[i];
    const text = usable(v) ? (v as string).trim() : null;
    const action = actions[i + 1];
    // Zeroth safety net: the free model writes lazily short prompts that lose
    // the scene, so anything thin is topped up from the chunk brief.
    const dense = expandPrompt(text ?? fallbackPrompt(s, action), brief, action);
    // Safety net: if the model drifted away from the beat's own LOCATION, pin
    // it back so the render can't relocate the scene.
    const pinned = enforceLocation(dense, locations[i + 1]);
    // Second safety net: keep the cast exactly as the chunk analysis resolved it
    // (including "nobody"), so pronoun lines can't fall back to the protagonist.
    const cast = castLock(enforceCast(pinned, casts[i + 1]), chunkCast, bible);
    // Third safety net: if the prompt lost this line's own action, pin the beat's
    // analysed action back so the image still shows what the script line says.
    return sanitizePrompt(enforceWorldState(enforceBeatAction(cast, action), state));
  });

  // Final pass: chain each panel to the one before it so the render is a
  // continuation of the previous image rather than a fresh interpretation.
  return chainContinuity(built, locations);
}

/**
 * Gap filler for beat maps. The analysis sometimes skips a line's LOCATION or
 * WHO; an empty slot used to mean "no lock at all", which is exactly when the
 * renderer invented a new place or a new person. Every line now inherits the
 * previous line's value instead.
 */
export function carryForward(
  map: Record<number, string>,
  count: number,
): Record<number, string> {
  const out: Record<number, string> = {};
  let last = "";
  for (let n = 1; n <= count; n++) {
    const v = map[n];
    if (v) last = v;
    if (last) out[n] = v ?? last;
  }
  return out;
}

/** Pulls one labelled block ("SETTING", "LIGHT", ...) out of a chunk brief. */
export function briefField(brief: string, label: string): string {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*([^\\n]+)`, "im");
  const m = re.exec(brief);
  return m ? (m[1] ?? "").trim() : "";
}

/**
 * Pulls the whole multi-line CAST block out of a chunk brief and splits it into
 * `Name -> fixed traits` entries.
 *
 * The bible only covers the characters introduced in the script's opening, so
 * everyone who shows up later (a shopkeeper, a friend, a second lead) had NO
 * description attached to their name at all — the renderer then drew whoever it
 * liked, which is how one elderly woman ended up in every single panel.
 */
export function parseCastBlock(brief: string): { name: string; traits: string }[] {
  if (!brief) return [];
  const m = /^\s*CAST\s*:\s*([\s\S]*?)(?=^\s*(?:OBJECTS|LIGHT|BEATS|STATE|SETTING)\s*:|$(?![\s\S]))/im.exec(brief);
  const block = (m?.[1] ?? "").trim();
  if (!block || /^none$/i.test(block)) return [];
  return block
    .split(/\n|;/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((l) => l.length > 3)
    .map((l) => {
      // "Name: traits", "Name - traits" or "Name (traits)"
      const sep = /^([^:(\-–]{2,40})\s*[:(\-–]\s*(.+?)\)?\s*$/.exec(l);
      if (!sep) return null;
      const name = (sep[1] ?? "").trim().replace(/[,.]$/, "");
      const traits = (sep[2] ?? "").trim();
      if (!name || !traits || traits.length < 4) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 8);
}

/**
 * Stamps each chunk-cast member's own gender, age and look next to their name
 * in the prompt, for anyone the bible does not already cover. This is what
 * stops a named young man from being rendered as a generic (or previously
 * drawn) old woman.
 */
export function castLock(
  prompt: string,
  cast: { name: string; traits: string }[],
  bible?: string,
): string {
  if (cast.length === 0) return prompt;
  const known = new Set(parseBible(bible ?? "").map((e) => e.name.toLowerCase()));
  const present = cast.filter(
    (e) =>
      !known.has(e.name.toLowerCase()) &&
      new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt),
  );
  if (present.length === 0) return prompt;
  const parts = present.map((e) => {
    const g = genderOf(e.traits);
    const age = ageOf(e.traits);
    const traits = e.traits.replace(/[.;]$/, "");
    const head = g
      ? `${e.name} is unmistakably ${g.toUpperCase()} (${g === "male" ? "a man, masculine face, body, hair and clothing" : "a woman, feminine face, body, hair and clothing"}) — ${traits}`
      : `${e.name} — ${traits}`;
    return age ? `${head}; ${e.name} looks exactly ${age}` : head;
  });
  return `${prompt} Fixed identities in this frame, never swapped or re-aged: ${parts.join("; ")}.`;
}


/**
 * Reads the brief's handover STATE line: the world facts that must not change
 * between panels (time of day, weather, clothing, props).
 */
export function parseState(brief: string): string {
  const raw = briefField(brief, "STATE");
  if (!raw) return "";
  return raw.replace(/\s*\|\s*/g, ", ").slice(0, 400);
}

/**
 * Locks the world facts. Panels of one chunk were coming back at different
 * times of day, in different weather and different clothes; the analysed state
 * is now restated on every single panel of the chunk.
 */
export function enforceWorldState(prompt: string, state: string): string {
  if (!state) return prompt;
  return (
    `${prompt} Unchanged story continuity for this whole sequence — ${state} — ` +
    `identical to the previous illustrations, never re-invented.`
  );
}

const MIN_PROMPT_WORDS = 60;

/**
 * Lazy-prompt repair.
 *
 * The free text model regularly returns a 15-word prompt ("a boy stands in a
 * room, sad"), and each of those renders as a completely different world. Short
 * prompts are topped up, deterministically, with this chunk's analysed setting,
 * light, objects and cast so every panel of the chunk describes the SAME place.
 */
export function expandPrompt(prompt: string, brief: string, action?: string): string {
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  if (words(prompt) >= MIN_PROMPT_WORDS || !brief) return prompt;

  const setting = briefField(brief, "SETTING");
  const light = briefField(brief, "LIGHT");
  const objects = briefField(brief, "OBJECTS");
  const cast = briefField(brief, "CAST");

  let out = prompt.replace(/\s*$/, "");
  if (!/[.!?]$/.test(out)) out += ".";
  if (action && words(out) < MIN_PROMPT_WORDS) out += ` The moment shown: ${action}.`;
  if (setting) out += ` The setting, drawn out in full detail: ${setting}.`;
  if (objects && !/^none$/i.test(objects)) out += ` Visible in the scene: ${objects}.`;
  if (light) out += ` Lighting and colour: ${light}.`;
  if (cast && !/^none$/i.test(cast) && words(out) < 110) {
    out += ` The people in this story look exactly like this: ${cast}.`;
  }
  return out;
}


/**
 * Reads the action half of 'n) LOCATION: ... | WHO: ... | <action>' out of a
 * chunk brief's BEATS block: 1-based line number -> what visibly happens.
 */
export function parseBeatActions(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-]([^\n]+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const parts = (m[2] ?? "").split("|");
    const action = (parts[parts.length - 1] ?? "").trim().replace(/[.;]+$/, "");
    if (n > 0 && parts.length > 1 && action.length > 3) out[n] = action.slice(0, 220);
  }
  return out;
}

/** Appends the analysed beat action when the prompt no longer reflects it. */
export function enforceBeatAction(prompt: string, action?: string): string {
  if (!action) return prompt;
  const p = prompt.toLowerCase();
  const words = action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return prompt;
  const hits = words.filter((w) => p.includes(w)).length;
  if (hits / words.length >= 0.34) return prompt;
  return `${prompt} This exact moment is shown: ${action}.`;
}


/**
 * Reads 'n) LOCATION: <place> | ...' out of a chunk brief's BEATS block and
 * returns a map of 1-based line number -> location.
 */
export function parseBeatLocations(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-]\s*LOCATION\s*:\s*([^|\n]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const place = (m[2] ?? "").trim().replace(/[.,;]+$/, "");
    if (n > 0 && place.length > 2) out[n] = place.slice(0, 80);
  }
  return out;
}

/**
 * Reads 'WHO: <names|no people>' out of a chunk brief's BEATS block and returns
 * a map of 1-based line number -> resolved cast for that shot.
 */
export function parseBeatCast(brief: string): Record<number, string> {
  const out: Record<number, string> = {};
  if (!brief) return out;
  const re = /^\s*(\d+)\s*[).:-][^\n]*?WHO\s*:\s*([^|\n]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) !== null) {
    const n = Number(m[1]);
    const who = (m[2] ?? "").trim().replace(/[.,;]+$/, "");
    if (n > 0 && who.length > 1) out[n] = who.slice(0, 120);
  }
  return out;
}

const NO_PEOPLE_RE = /^(no\s*people|none|nobody|no\s*one|no\s*character[s]?)$/i;
/** Mass beats: a head count would be wrong, the frame needs many people. */
const CROWD_RE = /^(crowd|crowds|many people|people|villagers|everyone|mob|group)$/i;


/**
 * Pins the prompt's cast to what the chunk analysis resolved.
 *  - 'no people' beats get an explicit empty-environment instruction.
 *  - named beats get the resolved names appended when the prompt omitted them,
 *    so a pronoun line never silently becomes the main character.
 */
export function enforceCast(prompt: string, who?: string): string {
  if (!who) return prompt;
  const cleaned = who.trim();
  if (NO_PEOPLE_RE.test(cleaned)) {
    return `${prompt} ${NO_PEOPLE_GUARD}.`;
  }
  if (CROWD_RE.test(cleaned)) {
    return (
      `${prompt} A crowd shot: many varied ordinary people fill the frame, each a separate whole body ` +
      `with its own clothing, none of them merged or duplicated, and no named main character among them.`
    );
  }

  const names = cleaned
    .split(/[,/&]| and /i)
    .map((n) => n.trim())
    .filter((n) => n.length > 1);
  if (names.length === 0) return prompt;
  const p = prompt.toLowerCase();
  const missing = names.filter((n) => {
    const key = n.toLowerCase().replace(/^(the|a|an)\s+/, "");
    const head = key.split(/\s+/)[0] ?? key;
    return !p.includes(key) && !p.includes(head);
  });
  // HEAD COUNT (critical): the render kept inventing extra bystanders — a solo
  // "he was lying on stone" beat came back with two or three figures. The exact
  // number of humans allowed in frame is now stated explicitly every time.
  const n = names.length;
  const count =
    n === 1
      ? `Exactly one person is in frame: ${names[0]}, completely alone, a solo shot with no other person, no bystander, no second figure and no reflection of another person anywhere in the image.`
      : `Exactly ${n} people are in frame — ${names.join(" and ")} — and nobody else; each of them is drawn once, as one separate whole body, never merged or duplicated.`;
  const add =
    missing.length === 0
      ? ""
      : ` ${missing.join(" and ")} must be present.`;
  return `${prompt} ${count}${add}`;
}



/** True when the prompt already names the location (or most of its words). */
function mentionsLocation(prompt: string, location: string): boolean {
  const p = prompt.toLowerCase();
  if (p.includes(location.toLowerCase())) return true;
  const words = location
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const hits = words.filter((w) => p.includes(w)).length;
  return hits / words.length >= 0.5;
}

/**
 * Location lock. The panel ALWAYS opens with the analysed place: Flux weights
 * the first tokens hardest, and the old "only when missing" behaviour let whole
 * runs drift into an unrelated kitchen while the script was in a cave.
 */
export function enforceLocation(prompt: string, location?: string): string {
  if (!location) return prompt;
  // Location EXCLUSIVITY: renders were blending places — wooden cabinets, vases
  // and kitchen shelves appearing inside a rock cave. The whole environment must
  // belong to this one place, so the exclusion is stated on every panel.
  const only =
    ` The entire environment is ${location} and nothing else: every wall, floor, ceiling, ` +
    `piece of furniture, prop and texture belongs to ${location}; no room, building, furniture ` +
    `or scenery from any other place appears anywhere in the frame.`;
  const body = mentionsLocation(prompt, location)
    ? `${prompt}${only}`
    : `${prompt} The scene takes place in ${location}, and nowhere else.${only}`;
  const opener = new RegExp(`^in ${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (opener.test(body)) return body;
  return `In ${location}: ${body}`;
}


/**
 * Panel-to-panel continuity. Consecutive panels are consecutive moments of one
 * continuous shot, so when the analysed location has not changed the render is
 * told explicitly that everything but the camera stays identical.
 */
export function chainContinuity(prompts: string[], locations: Record<number, string>): string[] {
  return prompts.map((p, i) => {
    if (i === 0) return p;
    const here = locations[i + 1];
    const before = locations[i];
    const samePlace = !here || !before || here.toLowerCase() === before.toLowerCase();
    if (!samePlace) {
      return `${p} This is the very next moment of the same continuous story, drawn in the identical art style as the previous illustration; the characters keep exactly the same faces, hair, clothing and colours.`;
    }
    return (
      `${p} Direct visual continuation of the immediately previous illustration: the same ${here ?? "place"}, ` +
      `the same time of day, the same weather, the same furniture and props in the same positions, ` +
      `the same characters with identical faces, hair and clothing — only the camera angle, the pose and the expression change.`
    );
  });
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
    const out = await zaiChat(
      [
        { role: "system", content: REVIEW_SYSTEM },
        {
          role: "user",
          content:
            (bible ? `CHARACTER SHEET:\n${bible}\n\n` : "") +
            `SCRIPT LINE:\n${line}\n\nRENDERED PROMPT:\n${prompt}`,
        },
      ],
      { temperature: 0.3, maxTokens: 600, attempts: 2, timeoutMs: 180_000, slot },
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
