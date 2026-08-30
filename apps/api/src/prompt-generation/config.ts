/**
 * Prompt generation — the contract, the defaults, and the money.
 *
 * No I/O, no database, no provider. Everything here is a pure value or a pure
 * function, so the parts an operator's wallet depends on — the filename rule
 * and the cost table — are testable without a stack.
 */

/** The only model V1 offers. Recorded per batch so history survives a change. */
export const DEFAULT_MODEL = 'grok-imagine-image-2.0' as const;

/**
 * V1 GENERATES EXACTLY TWO IMAGES PER PROMPT.
 *
 * Fixed rather than defaulted: the UI does not offer the control. The number
 * still travels as data — `prompt_batches.outputs_per_prompt` and
 * `prompt_jobs.requested_outputs` — and every loop, filename and rollup below
 * reads it rather than assuming 2. Raising it later is a UI change and a
 * default change, not a schema change.
 */
export const OUTPUTS_PER_PROMPT = 2;

/** xAI accepts 1-10 per request. Ours is a subset; the ceiling is theirs. */
export const MAX_OUTPUTS_PER_PROMPT = 10;

export type Resolution = '1k' | '2k';
export type Quality = 'low' | 'medium';

/**
 * Aspect ratios xAI documents for grok-imagine-image-2.0.
 *
 * Listed so an unsupported value is refused HERE, before a paid request is
 * made, rather than by the provider after we have already been charged for the
 * round trip.
 */
export const ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
  '21:9',
  '5:2',
  'auto',
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface GenerationParams {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  quality: Quality;
}

/**
 * V1 defaults: 2:3 portrait, 2K, medium.
 *
 * ON THE WORD "QUALITY", AND WHY THIS COMMENT EXISTS.
 *
 * The Grok Imagine web app has a control labelled "Quality 2.0". The API has a
 * parameter named `quality` taking `low` or `medium`. THESE ARE NOT DOCUMENTED
 * AS THE SAME THING and nothing here should be read as claiming they are — xAI
 * publishes no mapping between the web control and the API parameter, and we
 * have not verified one.
 *
 * What is documented, and all we rely on, is the API's own price ladder:
 *
 *     1k + low     $0.04     1k + medium  $0.06
 *     2k + low     $0.06     2k + medium  $0.08
 *
 * `medium` is the API's own default and its top documented value, so `2k` +
 * `medium` is the highest-fidelity combination the API exposes. That is the
 * closest available setting to a web user asking for the best output — a
 * best-available choice, NOT an equivalence claim. If xAI later documents a
 * mapping, or adds a `high`, this constant is the one place to change.
 */
export const DEFAULT_PARAMS: GenerationParams = {
  aspectRatio: '2:3',
  resolution: '2k',
  quality: 'medium',
};

/**
 * Published per-image prices, in USD.
 *
 * Used ONLY to show an estimate before an operator commits to a batch. It is
 * not billing, it is not reconciled against an invoice, and it goes stale the
 * day xAI changes a price — which is why the estimate is labelled an estimate
 * everywhere it is shown.
 */
export const PRICE_USD_PER_IMAGE: Record<Resolution, Record<Quality, number>> = {
  '1k': { low: 0.04, medium: 0.06 },
  '2k': { low: 0.06, medium: 0.08 },
};

export function pricePerImage(params: Pick<GenerationParams, 'resolution' | 'quality'>): number {
  return PRICE_USD_PER_IMAGE[params.resolution][params.quality];
}

export interface CostEstimate {
  prompts: number;
  outputsPerPrompt: number;
  images: number;
  pricePerImageUsd: number;
  totalUsd: number;
}

/**
 * What a batch is expected to cost, shown BEFORE it can be started.
 *
 * Rounded to cents at the end rather than per image, so 200 images cannot
 * accumulate a visible rounding drift against the operator's own arithmetic.
 */
export function estimateCost(
  prompts: number,
  outputsPerPrompt: number,
  params: Pick<GenerationParams, 'resolution' | 'quality'>,
): CostEstimate {
  const price = pricePerImage(params);
  const images = Math.max(0, prompts) * Math.max(0, outputsPerPrompt);
  return {
    prompts: Math.max(0, prompts),
    outputsPerPrompt: Math.max(0, outputsPerPrompt),
    images,
    pricePerImageUsd: price,
    totalUsd: Math.round(images * price * 100) / 100,
  };
}

/* ------------------------------------------------------------------ *
 * Filenames
 * ------------------------------------------------------------------ */

/** The extension every output carries. xAI returns JPEG bytes. */
export const OUTPUT_EXTENSION = 'jpg';

/**
 * `luna_001.txt` -> `luna_001`.
 *
 * Only a trailing `.txt` is removed, case-insensitively. A name with dots in it
 * keeps them — `set.2.final.txt` becomes `set.2.final`, not `set` — because the
 * operator's naming scheme is theirs and this function is not entitled to an
 * opinion about it.
 */
export function promptStem(originalFilename: string): string {
  return originalFilename.replace(/\.txt$/i, '');
}

/**
 * `luna_001.txt` + ordinal 1 -> `luna_001_1.jpg`.
 *
 * 1-BASED AND UNPADDED, and it has to stay that way: these names are already in
 * the operator's Drive after the first batch, so a later change to padding
 * would split one naming scheme into two. Extending to 3 or 4 outputs needs no
 * change here — the ordinal is a parameter, not a constant.
 */
export function outputFilename(originalFilename: string, ordinal: number): string {
  return `${promptStem(originalFilename)}_${ordinal}.${OUTPUT_EXTENSION}`;
}

/* ------------------------------------------------------------------ *
 * Ingestion rules
 * ------------------------------------------------------------------ */

/** One prompt file. Generous — a prompt is text, not media. */
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

/** How many files one upload request may carry. */
export const MAX_FILES_PER_UPLOAD = 500;

export type PromptFileRejection =
  | 'not_txt'
  | 'empty'
  | 'too_large'
  | 'duplicate_in_batch'
  | 'undecodable';

export interface PromptFileInput {
  filename: string;
  bytes: Buffer;
}

export type PromptFileOutcome =
  | { filename: string; accepted: true; promptText: string }
  | { filename: string; accepted: false; reason: PromptFileRejection };

/**
 * Turns uploaded bytes into a prompt, or says why it could not.
 *
 * THE PROMPT IS NOT TOUCHED. There is no trim, no normalisation, no case
 * change, no whitespace collapsing and no truncation anywhere in this function
 * or downstream of it — what the operator wrote is what xAI receives. The only
 * transformation is UTF-8 decoding, and a leading byte-order mark is stripped
 * because it is a file-format artefact rather than part of the prompt: left in,
 * it would travel to the provider as an invisible leading character.
 *
 * Emptiness is judged on the TRIMMED text but the UNTRIMMED text is what gets
 * stored — a file of pure whitespace is a mistake worth refusing, while a
 * prompt that deliberately opens with a newline keeps it.
 */
export function readPromptFile(input: PromptFileInput): PromptFileOutcome {
  const { filename, bytes } = input;
  if (!/\.txt$/i.test(filename)) {
    return { filename, accepted: false, reason: 'not_txt' };
  }
  if (bytes.byteLength > MAX_PROMPT_FILE_BYTES) {
    return { filename, accepted: false, reason: 'too_large' };
  }
  let text: string;
  try {
    text = bytes.toString('utf8');
  } catch {
    return { filename, accepted: false, reason: 'undecodable' };
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (withoutBom.trim().length === 0) {
    return { filename, accepted: false, reason: 'empty' };
  }
  return { filename, accepted: true, promptText: withoutBom };
}

/** Operator-facing copy for a refusal. One sentence, names the fix. */
export function rejectionMessage(reason: PromptFileRejection): string {
  switch (reason) {
    case 'not_txt':
      return 'Only .txt files are accepted — one prompt per file.';
    case 'empty':
      return 'That file has no prompt text in it.';
    case 'too_large':
      return `That file is larger than ${Math.round(MAX_PROMPT_FILE_BYTES / 1024)}KB, which is far more than a prompt.`;
    case 'duplicate_in_batch':
      return 'A file with this name is already in this batch, so it was not added again.';
    case 'undecodable':
      return 'That file could not be read as text.';
  }
}
