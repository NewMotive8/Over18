/**
 * Vision-capable message shapes (Phase 2 avatar-derived persona).
 *
 * A DELIBERATELY SEPARATE contract from llm/types.ts, not an extension of it.
 * LlmMessage.content is a plain string throughout the chat/Autofill path, and
 * that path is shared production surface — widening it to accept multi-part
 * content for the sake of one image-analysis feature would be a change to
 * code the chat engine depends on for every message. Persona generation is
 * the only caller of this shape, so it gets its own.
 *
 * The content-part shape mirrors the OpenAI-compatible vision wire format
 * (text + image_url parts) since that is the protocol the existing chat
 * adapter already speaks — see llm/openai-compatible.ts's own note that this
 * is a protocol choice, not a vendor choice.
 */

export interface LlmTextContentPart {
  type: 'text';
  text: string;
}

export interface LlmImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type LlmVisionContentPart = LlmTextContentPart | LlmImageContentPart;

export interface LlmVisionMessage {
  role: 'system' | 'user';
  /** A system message is always plain text; a user message may carry an image. */
  content: string | LlmVisionContentPart[];
}

export interface LlmVisionRequest {
  messages: LlmVisionMessage[];
  maxTokens: number;
  temperature: number;
}

/**
 * One reply, plus WHY the model stopped producing it.
 *
 * `finishReason` is carried because a reply that ran out of room is not the
 * same failure as a reply that said something unusable, and only the adapter
 * can tell them apart -- the distinction exists on the wire and nowhere else.
 * It stays a raw protocol value rather than an interpreted one: deciding
 * whether a truncated reply is still usable needs to know what the reply was
 * FOR, which this layer deliberately does not.
 */
export interface LlmVisionReply {
  /** The assistant's reply text, already trimmed and known non-empty. */
  text: string;
  /**
   * The provider's own stop reason -- 'stop', 'length', and whatever else a
   * given endpoint reports. Null when it reported none; never inferred.
   */
  finishReason: string | null;
}

/** The single contract a vision-capable inference adapter implements. */
export interface LlmVisionClient {
  /** Returns the assistant's reply, or throws LlmError. */
  generate(request: LlmVisionRequest): Promise<LlmVisionReply>;
}

// Failures reuse LlmError/LlmErrorKind from llm/types.js directly — import
// them from there, not from this module.
