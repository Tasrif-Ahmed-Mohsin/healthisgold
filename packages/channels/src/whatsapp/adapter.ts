/**
 * The WhatsApp Cloud API adapter.
 *
 * Transport and normalisation only. It holds no clinical logic and imports nothing from the
 * clinical core, so nothing about how this system decides urgency depends on Meta.
 */

import type { ChannelAdapter, InboundMessage, OutboundResult } from '../adapter.js';
import { parseWhatsAppWebhook } from './inbound.js';

export interface WhatsAppConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly graphVersion?: string;
  readonly timeoutMs?: number;
}

/**
 * Meta error codes this system reacts to differently.
 *
 * 131047 is the important one: it means the 24-hour service window has closed, so a
 * free-form reply cannot be delivered and only a pre-approved template will go through.
 * That is an ordinary state of the world, not a bug, and the caller needs to tell the
 * difference between it and a real failure.
 */
export const WHATSAPP_ERROR = {
  outsideServiceWindow: 131_047,
  recipientNotInAllowedList: 131_030,
  expiredToken: 190,
} as const;

export class ChannelError extends Error {
  readonly code: number | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: { code?: number; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ChannelError';
    this.code = options.code;
    this.status = options.status;
  }

  /** True when the failure is "you may not free-form message this person right now". */
  get isOutsideServiceWindow(): boolean {
    return this.code === WHATSAPP_ERROR.outsideServiceWindow;
  }
}

interface GraphSendResponse {
  messages?: { id?: string }[];
  error?: { message?: string; code?: number };
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;

  readonly #phoneNumberId: string;
  readonly #accessToken: string;
  readonly #graphVersion: string;
  readonly #timeoutMs: number;

  constructor(config: WhatsAppConfig) {
    this.#phoneNumberId = config.phoneNumberId;
    this.#accessToken = config.accessToken;
    this.#graphVersion = config.graphVersion ?? 'v21.0';
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  parseInbound(payload: unknown): InboundMessage[] {
    return parseWhatsAppWebhook(payload);
  }

  async sendText(to: string, text: string): Promise<OutboundResult> {
    return this.#send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  async sendTemplate(to: string, templateName: string, languageCode = 'en'): Promise<OutboundResult> {
    return this.#send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode } },
    });
  }

  async #send(body: unknown): Promise<OutboundResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(`https://graph.facebook.com/${this.#graphVersion}/${this.#phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as GraphSendResponse;

      if (!response.ok) {
        const code = payload.error?.code;
        throw new ChannelError(payload.error?.message ?? `WhatsApp send failed with ${response.status}`, {
          ...(code === undefined ? {} : { code }),
          status: response.status,
        });
      }

      const externalId = payload.messages?.[0]?.id;
      if (externalId === undefined) {
        throw new ChannelError('WhatsApp accepted the send but returned no message id.', { status: response.status });
      }
      return { externalId };
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ChannelError(`WhatsApp send timed out after ${this.#timeoutMs}ms.`, { cause: error });
      }
      throw new ChannelError(`WhatsApp send failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
