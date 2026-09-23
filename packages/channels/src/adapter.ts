/**
 * The channel boundary.
 *
 * Everything below this line is provider-specific; everything above it sees one shape. That
 * is what lets a new channel be added without touching the code that decides whether someone
 * is in danger.
 *
 * Nothing in this package imports the clinical core, and nothing here interprets content. An
 * adapter's entire job is transport and normalisation.
 */

export const CHANNEL_IDS = ['whatsapp', 'web', 'sms', 'console', 'simulated'] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

/**
 * A single piece of an inbound message.
 *
 * Media arrives as an identifier, not as bytes. Downloading a voice note or a prescription
 * photo is a separate, authorised, logged step — not something that happens implicitly while
 * parsing a webhook from the public internet.
 */
export type MessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'audio'; readonly mediaId: string; readonly mimeType: string }
  | { readonly kind: 'image'; readonly mediaId: string; readonly mimeType: string; readonly caption?: string }
  | { readonly kind: 'document'; readonly mediaId: string; readonly mimeType: string; readonly filename?: string }
  | { readonly kind: 'location'; readonly latitude: number; readonly longitude: number }
  | { readonly kind: 'unsupported'; readonly description: string };

export interface InboundMessage {
  readonly channel: ChannelId;
  /**
   * Stable per-channel identity of the sender — for WhatsApp, the number in E.164.
   *
   * This is *not* a patient identifier. Mapping it to a patient is the job of the identity
   * and consent layer, which is where the decision "is this person who they claim to be,
   * and have they agreed to this" belongs. Phone numbers are reassigned and shared.
   */
  readonly senderRef: string;
  /**
   * The provider's own message id.
   *
   * Required for idempotency. Meta retries a webhook until it gets a 200, so the same
   * message will arrive more than once — and a duplicated symptom report is a duplicated
   * case in a clinical queue.
   */
  readonly externalId: string;
  readonly receivedAt: string;
  readonly parts: readonly MessagePart[];
  /** Display name as the provider reports it. Untrusted: the sender chooses it. */
  readonly senderName?: string;
}

/** Text parts joined, for the intake pipeline. Media parts are handled separately. */
export function textOf(message: InboundMessage): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export interface OutboundResult {
  readonly externalId: string;
}

export interface ChannelAdapter {
  readonly channel: ChannelId;

  /**
   * Turns a provider payload into normalised messages.
   *
   * Must not throw on unexpected shapes. Providers add fields and message types without
   * notice, and a parser that throws turns an unknown sticker into a failed webhook, which
   * Meta then retries indefinitely. Unrecognised content becomes an `unsupported` part.
   */
  parseInbound(payload: unknown): InboundMessage[];

  /**
   * Sends a free-form reply.
   *
   * On WhatsApp this only succeeds inside the 24-hour service window opened by the
   * patient's last message. Outside it, the provider rejects the send and a pre-approved
   * template is the only delivery path — see `sendTemplate`.
   */
  sendText(to: string, text: string): Promise<OutboundResult>;

  /** Sends a pre-approved template. The only way to initiate contact outside the window. */
  sendTemplate?(to: string, templateName: string, languageCode: string): Promise<OutboundResult>;
}
