import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseScript } from "./script";
import {
  buildCharacterBible,
  writePrompts,
  generateImage,
  generateCheckedImage,
  analyzeChunk,
} from "./manga.server";

export const analyzeScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ script: z.string().min(5) }).parse(d))
  .handler(async ({ data }) => {
    const segments = parseScript(data.script);
    if (segments.length === 0) {
      throw new Error(
        "No timestamps found. Each line needs a time like 0:00, (0:00) or [0:00].",
      );
    }
    const bible = await buildCharacterBible(data.script);
    return { segments, bible };
  });

/**
 * Chunk analysis on its own.
 *
 * Analysis is CHEAP and must be strictly sequential: each chunk brief starts
 * from the previous chunk's handover STATE (place, time, weather, clothing,
 * who is together), which is what makes the whole script one continuous world
 * instead of a series of unrelated scenes. Only the expensive prompt writing
 * then fans out over the key pool.
 */
export const briefForBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string(),
        slot: z.number().int().min(0).default(0),
        context: z.string().max(8000).optional(),
        segments: z.array(
          z.object({
            index: z.number(),
            start: z.number(),
            end: z.number(),
            text: z.string(),
          }),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const brief = await analyzeChunk(data.bible, data.segments, data.slot, data.context ?? "");
    return { brief };
  });

/**
 * One chunk of the script: analysed first (setting, cast actually present,
 * objects, mood, per-line beats), then storyboarded against that analysis so
 * every panel in the chunk keeps the chunk's detail and continuity.
 * Still exactly one prompt per timestamp.
 *
 * A `brief` produced by `briefForBatch` is reused when given, so the sequential
 * analysis chain is never thrown away and re-run per chunk.
 */
export const promptsForBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string(),
        // which API key slot this chunk should use, so parallel chunks
        // spread across the whole key pool
        slot: z.number().int().min(0).default(0),
        // the script lines / previous chunk brief before this chunk — continuity
        // context so the storyboard doesn't lose scene detail at chunk boundaries
        context: z.string().max(8000).optional(),
        // brief from the sequential analysis pass; re-analysed only if absent
        brief: z.string().max(8000).optional(),
        segments: z.array(
          z.object({
            index: z.number(),
            start: z.number(),
            end: z.number(),
            text: z.string(),
          }),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const ctx = data.context ?? "";
    const brief =
      data.brief && data.brief.length > 20
        ? data.brief
        : await analyzeChunk(data.bible, data.segments, data.slot, ctx);
    const prompts = await writePrompts(data.bible, data.segments, data.slot, ctx, brief);
    return { prompts, brief };
  });




export const renderImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        prompt: z.string().min(5),
        seed: z.number().int(),
        // text-only character consistency sheet, injected into every render
        bible: z.string().optional(),
        slot: z.number().int().min(0).default(0),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const url = await generateImage(data.prompt, data.seed, data.slot, data.bible);
    return { url };
  });

/**
 * Renders several panels in one round trip.
 *
 * A 2-hour script is ~1500 panels. Asking the browser to hold ~100 separate
 * server-function requests open saturates its connection pool, so each request
 * instead fans a small group out server-side. Failures are reported per item so
 * one bad panel never fails the group.
 */
export const renderBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string().optional(),
        jobs: z
          .array(
            z.object({
              index: z.number().int(),
              prompt: z.string().min(5),
              seed: z.number().int(),
              slot: z.number().int().min(0).default(0),
              // the script line this panel illustrates — enables the
              // post-render review + single rewrite/regenerate pass
              line: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const results = await Promise.all(
      data.jobs.map(async (j) => {
        try {
          const out = await generateCheckedImage(
            j.prompt,
            j.seed,
            j.slot,
            data.bible,
            j.line,
          );
          return {
            index: j.index,
            url: out.url,
            prompt: out.prompt,
            revised: out.revised,
            error: null as string | null,
          };
        } catch (e) {
          return {
            index: j.index,
            url: null as string | null,
            prompt: j.prompt,
            revised: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    return { results };
  });
