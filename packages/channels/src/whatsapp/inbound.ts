/**
 * Parses Meta's webhook payload into normalised inbound messages.
 *
 * Written defensively throughout. Meta adds message types and fields without notice, and a
 * parser that throws on an unrecognised sticker turns into a failed webhook, which Meta then
 * retries — repeatedly, for a message nobody can process. Unknown content becomes an
 * `unsupported` part and the message still reaches a human.
 */

import type { InboundMessage, MessagePart } from '../adapter.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Unix seconds (as Meta sends them) to an ISO timestamp, falling back to now. */
function toIso(timestamp: unknown): string {
  const seconds = num(timestamp);
  if (seconds === undefined) return new Date().toISOString();
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parsePart(message: Record<string, unknown>): MessagePart {
  const type = str(message['type']) ?? 'unknown';

  switch (type) {
    case 'text': {
      const body = isRecord(message['text']) ? str(message['text']['body']) : undefined;
      return body === undefined ? { kind: 'unsupported', description: 'text message with no body' } : { kind: 'text', text: body };
    }

    case 'audio':
    case 'voice': {
      const audio = isRecord(message['audio']) ? message['audio'] : undefined;
      const mediaId = audio ? str(audio['id']) : undefined;
      if (mediaId === undefined) return { kind: 'unsupported', description: 'audio message with no media id' };
      return { kind: 'audio', mediaId, mimeType: (audio ? str(audio['mime_type']) : undefined) ?? 'audio/ogg' };
    }

    case 'image': {
      const image = isRecord(message['image']) ? message['image'] : undefined;
      const mediaId = image ? str(image['id']) : undefined;
      if (mediaId === undefined) return { kind: 'unsupported', description: 'image message with no media id' };
      const caption = image ? str(image['caption']) : undefined;
      return {
        kind: 'image',
        mediaId,
        mimeType: (image ? str(image['mime_type']) : undefined) ?? 'image/jpeg',
        ...(caption === undefined ? {} : { caption }),
      };
    }

    case 'document': {
      const doc = isRecord(message['document']) ? message['document'] : undefined;
      const mediaId = doc ? str(doc['id']) : undefined;
      if (mediaId === undefined) return { kind: 'unsupported', description: 'document message with no media id' };
      const filename = doc ? str(doc['filename']) : undefined;
      return {
        kind: 'document',
        mediaId,
        mimeType: (doc ? str(doc['mime_type']) : undefined) ?? 'application/octet-stream',
        ...(filename === undefined ? {} : { filename }),
      };
    }

    case 'location': {
      const location = isRecord(message['location']) ? message['location'] : undefined;
      const latitude = location ? num(location['latitude']) : undefined;
      const longitude = location ? num(location['longitude']) : undefined;
      if (latitude === undefined || longitude === undefined) {
        return { kind: 'unsupported', description: 'location message with no coordinates' };
      }
      return { kind: 'location', latitude, longitude };
    }

    default:
      return { kind: 'unsupported', description: `unhandled message type: ${type}` };
  }
}

/**
 * Extracts every message in a webhook payload.
 *
 * Delivery receipts arrive on the same webhook under `statuses`. They are not inbound
 * messages and are ignored here; tracking them belongs to the outbound side.
 */
export interface WebhookSummary {
  /** Which subscribed fields fired, e.g. "messages", "account_update". */
  readonly fields: readonly string[];
  readonly messageCount: number;
  readonly statusCount: number;
  /** Message `type` values present, e.g. "text", "audio". Never the content. */
  readonly messageTypes: readonly string[];
}

/**
 * Describes a webhook delivery without revealing anything a patient wrote.
 *
 * Exists because the common failure — a webhook that verifies and then delivers nothing
 * useful — is invisible otherwise. Knowing which field fired distinguishes "the messages
 * subscription is off" from "an unrelated account event arrived", and those have completely
 * different fixes. Field names and message types are metadata, never content.
 */
export function summariseWhatsAppWebhook(payload: unknown): WebhookSummary {
  const fields: string[] = [];
  const messageTypes: string[] = [];
  let messageCount = 0;
  let statusCount = 0;

  if (!isRecord(payload)) return { fields, messageCount, statusCount, messageTypes };

  for (const entry of arr(payload['entry'])) {
    if (!isRecord(entry)) continue;
    for (const change of arr(entry['changes'])) {
      if (!isRecord(change)) continue;
      const field = str(change['field']);
      if (field !== undefined) fields.push(field);
      const value = isRecord(change['value']) ? change['value'] : undefined;
      if (value === undefined) continue;
      const messages = arr(value['messages']);
      messageCount += messages.length;
      statusCount += arr(value['statuses']).length;
      for (const message of messages) {
        if (!isRecord(message)) continue;
        const type = str(message['type']);
        if (type !== undefined) messageTypes.push(type);
      }
    }
  }

  return { fields, messageCount, statusCount, messageTypes };
}

export function parseWhatsAppWebhook(payload: unknown): InboundMessage[] {
  if (!isRecord(payload)) return [];

  const messages: InboundMessage[] = [];

  for (const entry of arr(payload['entry'])) {
    if (!isRecord(entry)) continue;

    for (const change of arr(entry['changes'])) {
      if (!isRecord(change)) continue;
      const value = isRecord(change['value']) ? change['value'] : undefined;
      if (value === undefined) continue;

      // Display names, keyed by wa_id. The sender picks this string, so it is untrusted
      // and is carried for display only — never used to identify anyone.
      const names = new Map<string, string>();
      for (const contact of arr(value['contacts'])) {
        if (!isRecord(contact)) continue;
        const waId = str(contact['wa_id']);
        const profile = isRecord(contact['profile']) ? contact['profile'] : undefined;
        const name = profile ? str(profile['name']) : undefined;
        if (waId !== undefined && name !== undefined) names.set(waId, name);
      }

      for (const raw of arr(value['messages'])) {
        if (!isRecord(raw)) continue;
        const from = str(raw['from']);
        const externalId = str(raw['id']);
        if (from === undefined || externalId === undefined) continue;

        const senderName = names.get(from);
        messages.push({
          channel: 'whatsapp',
          senderRef: from,
          externalId,
          receivedAt: toIso(raw['timestamp']),
          parts: [parsePart(raw)],
          ...(senderName === undefined ? {} : { senderName }),
        });
      }
    }
  }

  return messages;
}
