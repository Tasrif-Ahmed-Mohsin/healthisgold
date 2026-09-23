/**
 * An in-memory channel.
 *
 * It exists so the whole pipeline — intake, safety kernel, queue, coordinator review — can be
 * exercised and demonstrated end to end without Meta approval, a verified business, a public
 * tunnel, or a single billed message. Getting WhatsApp credentials is paperwork on someone
 * else's timetable, and no part of building this should be blocked behind it.
 *
 * It is also what tests use, so the code paths a demo exercises are the tested ones.
 */

import type { ChannelAdapter, InboundMessage, OutboundResult } from './adapter.js';

export interface SentMessage {
  readonly to: string;
  readonly text: string;
  readonly sentAt: string;
  readonly externalId: string;
  readonly template?: string;
}

export class SimulatedAdapter implements ChannelAdapter {
  readonly channel = 'simulated' as const;

  readonly #sent: SentMessage[] = [];
  #counter = 0;

  /** Everything this adapter has been asked to send, oldest first. */
  get sent(): readonly SentMessage[] {
    return this.#sent;
  }

  /**
   * Builds an inbound message as if a patient had sent it.
   *
   * Takes the same shape the real adapter produces, so a scenario written against this is
   * a valid scenario against WhatsApp.
   */
  static inbound(senderRef: string, text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
      channel: 'simulated',
      senderRef,
      externalId: `sim-${crypto.randomUUID()}`,
      receivedAt: new Date().toISOString(),
      parts: [{ kind: 'text', text }],
      ...overrides,
    };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    if (Array.isArray(payload)) return payload as InboundMessage[];
    return payload === undefined || payload === null ? [] : [payload as InboundMessage];
  }

  async sendText(to: string, text: string): Promise<OutboundResult> {
    return this.#record({ to, text });
  }

  async sendTemplate(to: string, templateName: string): Promise<OutboundResult> {
    return this.#record({ to, text: `[template: ${templateName}]`, template: templateName });
  }

  #record(message: { to: string; text: string; template?: string }): OutboundResult {
    this.#counter += 1;
    const externalId = `sim-out-${this.#counter}`;
    this.#sent.push({
      to: message.to,
      text: message.text,
      sentAt: new Date().toISOString(),
      externalId,
      ...(message.template === undefined ? {} : { template: message.template }),
    });
    return { externalId };
  }

  clear(): void {
    this.#sent.length = 0;
    this.#counter = 0;
  }
}
