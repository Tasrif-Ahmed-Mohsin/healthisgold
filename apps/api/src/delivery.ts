/**
 * Getting a message to a patient.
 *
 * Every message a person sends is recorded on the case whether or not it is delivered, so the
 * patient portal always shows it. WhatsApp is attempted when the patient has a WhatsApp
 * identity; outside Meta's 24-hour service window that attempt fails, and the portal becomes
 * the only route. That is exactly why the portal exists: it is the fallback that does not
 * depend on a messaging platform's billing rules.
 */

import { ChannelError, type WhatsAppAdapter } from '@hc/channels';
import type { CaseStore } from '@hc/store';

export interface DeliveryResult {
  readonly channel: 'whatsapp' | 'web';
  readonly delivered: boolean;
  readonly outsideWindow: boolean;
  readonly externalId?: string;
  readonly error?: string;
}

export async function deliverToPatient(
  deps: { readonly store: CaseStore; readonly whatsapp: WhatsAppAdapter | null },
  patientId: string,
  text: string,
): Promise<DeliveryResult> {
  const channels = await deps.store.channelsForPatient(patientId);
  const whatsappRef = channels.find((channel) => channel.channel === 'whatsapp')?.ref;

  if (whatsappRef === undefined || deps.whatsapp === null) {
    // Recorded on the case; the patient reads it in the portal.
    return { channel: 'web', delivered: true, outsideWindow: false };
  }

  try {
    const sent = await deps.whatsapp.sendText(whatsappRef, text);
    return { channel: 'whatsapp', delivered: true, outsideWindow: false, externalId: sent.externalId };
  } catch (error) {
    return {
      channel: 'whatsapp',
      delivered: false,
      outsideWindow: error instanceof ChannelError && error.isOutsideServiceWindow,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
