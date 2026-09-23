/**
 * Credential smoke test for WhatsApp.
 *
 * Meta's failures are famously unhelpful — a wrong phone number ID and an expired token both
 * surface as a generic error, and the webhook silently delivers nothing for at least four
 * unrelated reasons. This script checks each credential separately and says which one is
 * wrong, so a broken setup takes a minute instead of an evening.
 *
 *   npm run check:whatsapp -w @hc/api
 */

import { loadConfig, type WhatsAppSettings } from '../config.ts';

const OK = '  ok   ';
const BAD = '  FAIL ';
const WARN = '  warn ';

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Meta error codes worth translating into something actionable. */
function explain(code: number | undefined, message: string): string {
  switch (code) {
    case 190:
      return 'Access token is invalid or expired. If you are using the 24-hour token from the API Setup page, make a permanent system-user token instead (docs/whatsapp-setup.md step 6).';
    case 100:
      return 'Meta does not recognise that ID. Check you copied the Phone number ID (a long number under the From dropdown) and not the phone number itself.';
    case 200:
    case 10:
      return 'The token lacks permission. The system user needs whatsapp_business_messaging and whatsapp_business_management, and Full control of the app.';
    case 803:
      return 'That object exists but this token cannot see it — usually the system user was not given access to the app or the WABA.';
    default:
      return message;
  }
}

async function graphGet(settings: WhatsAppSettings, path: string, fields: string): Promise<Record<string, unknown>> {
  const url = `https://graph.facebook.com/${settings.graphVersion}/${path}?fields=${fields}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${settings.accessToken}` } });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & GraphError;

  if (!response.ok) {
    const error = payload.error;
    throw new Error(explain(error?.code, error?.message ?? `HTTP ${response.status}`));
  }
  return payload;
}

function checkShape(settings: WhatsAppSettings): boolean {
  let allGood = true;

  // App secrets are 32 hex characters. A wrong length here is almost always a truncated
  // paste, and it fails later as "invalid signature", which looks like a code bug.
  if (!/^[0-9a-f]{32}$/i.test(settings.appSecret)) {
    console.log(`${BAD} app secret: expected 32 hex characters, got ${settings.appSecret.length}. Re-copy it from App settings → Basic.`);
    allGood = false;
  } else {
    console.log(`${OK} app secret: correct shape`);
  }

  if (!/^\d+$/.test(settings.phoneNumberId)) {
    console.log(`${BAD} phone number ID: should be digits only. You may have pasted the phone number instead of its ID.`);
    allGood = false;
  }

  if (settings.verifyToken.length < 16) {
    console.log(`${WARN} verify token is short. Any string works, but a long random one is better.`);
  }

  return allGood;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // A config problem is a message to the operator, not a stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (config.whatsapp === null) {
    console.error('WhatsApp is not configured. Fill in the WHATSAPP_* values in .env — see docs/whatsapp-setup.md.');
    process.exit(1);
  }

  const settings = config.whatsapp;
  console.log(`graph version: ${settings.graphVersion}\n`);

  let healthy = checkShape(settings);

  try {
    const phone = await graphGet(settings, settings.phoneNumberId, 'display_phone_number,verified_name,quality_rating');
    console.log(`${OK} phone number: ${String(phone['display_phone_number'] ?? '?')} (${String(phone['verified_name'] ?? 'unnamed')})`);
    if (phone['quality_rating'] !== undefined) {
      console.log(`       quality rating: ${String(phone['quality_rating'])}`);
    }
  } catch (error) {
    console.log(`${BAD} phone number: ${error instanceof Error ? error.message : String(error)}`);
    healthy = false;
  }

  try {
    const waba = await graphGet(settings, settings.businessAccountId, 'name,timezone_id');
    console.log(`${OK} business account: ${String(waba['name'] ?? '?')}`);
  } catch (error) {
    console.log(`${BAD} business account: ${error instanceof Error ? error.message : String(error)}`);
    healthy = false;
  }

  // The failure this catches is the nastiest one in the whole setup. A WABA routes inbound
  // messages to whichever apps are subscribed *to it*, which is a different thing from the
  // app's own webhook configuration. Meta's dashboard shows the second and hides the first,
  // and its "Test" button bypasses the WABA entirely — so the webhook can verify, the Test
  // button can succeed, and real messages can still go nowhere. Counting subscribed apps is
  // not enough: a new WABA arrives already subscribed to one of Meta's own internal apps.
  try {
    const subs = await graphGet(settings, `${settings.businessAccountId}/subscribed_apps`, 'whatsapp_business_api_data');
    const data = subs['data'];
    const apps = Array.isArray(data) ? data : [];

    const names: string[] = [];
    let ours = false;
    for (const entry of apps) {
      if (typeof entry !== 'object' || entry === null) continue;
      const info = (entry as { whatsapp_business_api_data?: { id?: string; name?: string } }).whatsapp_business_api_data;
      if (info?.id === settings.appId) ours = true;
      if (info?.name !== undefined) names.push(info.name);
    }

    if (ours) {
      console.log(`${OK} WABA routes to your app${names.length > 1 ? ` (alongside: ${names.filter((n) => n !== undefined).join(', ')})` : ''}`);
    } else {
      console.log(`${BAD} your app is NOT subscribed to this WABA, so inbound messages will never arrive.`);
      console.log(`       Subscribed instead: ${names.length > 0 ? names.join(', ') : 'nothing'}`);
      console.log(`       Fix: curl -X POST -H "Authorization: Bearer $TOKEN" \\`);
      console.log(`            https://graph.facebook.com/${settings.graphVersion}/${settings.businessAccountId}/subscribed_apps`);
      healthy = false;
    }
  } catch (error) {
    console.log(`${WARN} could not read WABA app subscriptions: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(
    healthy
      ? '\nCredentials look good. Remember the app must also be PUBLISHED, or Meta delivers no real messages at all.'
      : '\nFix the failures above, then run this again.',
  );
  process.exit(healthy ? 0 : 1);
}

void main();
