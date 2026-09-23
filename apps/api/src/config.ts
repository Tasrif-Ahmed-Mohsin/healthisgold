/**
 * Configuration.
 *
 * This is the only module that reads credentials, and it reads them only from the
 * environment. Nothing downstream accepts a key as an argument from anywhere else.
 *
 * Two rules hold here:
 *   - A missing *required* value fails at startup, loudly, naming what is missing. A server
 *     that boots without its app secret and then silently accepts unsigned webhooks is worse
 *     than one that refuses to start.
 *   - No value is ever printed. `describeConfig` reports presence, never content.
 */

export interface WhatsAppSettings {
  /** Public identifier, not a credential. Needed to check which app a WABA routes to. */
  readonly appId: string;
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly graphVersion: string;
}

export interface LlmSettings {
  readonly provider: 'deepseek';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fastModel: string;
  readonly reasoningModel: string;
}

export interface Config {
  readonly port: number;
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  /**
   * Null until credentials are present.
   *
   * The server must run without them. Getting WhatsApp credentials depends on Meta's
   * approval timetable, and none of the intake pipeline, the safety kernel or the
   * coordinator console should be unreachable while that is pending — the simulated
   * channel covers the same ground in the meantime.
   */
  readonly whatsapp: WhatsAppSettings | null;
  readonly llm: LlmSettings | null;
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

type GroupResult =
  /** None of the keys are set — the integration is intentionally off. */
  | { readonly kind: 'absent' }
  /** Some but not all — almost always a typo or a half-finished setup. */
  | { readonly kind: 'partial'; readonly missing: readonly string[] }
  | { readonly kind: 'complete'; readonly values: Readonly<Record<string, string>> };

/** All-or-nothing group loading: a half-configured integration is a runtime surprise. */
function loadGroup(env: Env, keys: readonly string[]): GroupResult {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const value = read(env, key);
    if (value === undefined) missing.push(key);
    else values[key] = value;
  }

  if (missing.length === keys.length) return { kind: 'absent' };
  if (missing.length > 0) return { kind: 'partial', missing };
  return { kind: 'complete', values };
}

/**
 * The values Meta issues. All four or none — a half-set is always a mistake.
 *
 * `WHATSAPP_VERIFY_TOKEN` is deliberately not in this list. You invent it rather than
 * receiving it from Meta, so it is reasonable to generate it before you have anything else,
 * and having done so must not make the server think WhatsApp is half-configured.
 */
const WHATSAPP_KEYS = [
  'WHATSAPP_APP_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = read(env, 'NODE_ENV') ?? 'development';
  const portRaw = read(env, 'PORT') ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ConfigError(`PORT must be a valid port number, got "${portRaw}".`);
  }

  const whatsappGroup = loadGroup(env, WHATSAPP_KEYS);
  if (whatsappGroup.kind === 'partial') {
    throw new ConfigError(
      `WhatsApp is partially configured. Missing: ${whatsappGroup.missing.join(', ')}. ` +
        'Set all of them, or none of them to run without WhatsApp. See docs/whatsapp-setup.md.',
    );
  }

  // Only required once the Meta credentials exist, because that is the point at which a
  // webhook can actually be registered.
  const verifyToken = read(env, 'WHATSAPP_VERIFY_TOKEN');
  if (whatsappGroup.kind === 'complete' && verifyToken === undefined) {
    throw new ConfigError(
      'WHATSAPP_VERIFY_TOKEN is not set. Invent any random string, put the same value in .env and ' +
        "in Meta's webhook form. Generate one with: openssl rand -hex 24",
    );
  }

  const deepseekKey = read(env, 'DEEPSEEK_API_KEY');

  return {
    port,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    whatsapp:
      whatsappGroup.kind !== 'complete'
        ? null
        : {
            appId: whatsappGroup.values['WHATSAPP_APP_ID'] ?? '',
            phoneNumberId: whatsappGroup.values['WHATSAPP_PHONE_NUMBER_ID'] ?? '',
            businessAccountId: whatsappGroup.values['WHATSAPP_BUSINESS_ACCOUNT_ID'] ?? '',
            accessToken: whatsappGroup.values['WHATSAPP_ACCESS_TOKEN'] ?? '',
            appSecret: whatsappGroup.values['WHATSAPP_APP_SECRET'] ?? '',
            verifyToken: verifyToken ?? '',
            graphVersion: read(env, 'WHATSAPP_GRAPH_VERSION') ?? 'v21.0',
          },
    llm:
      deepseekKey === undefined
        ? null
        : {
            provider: 'deepseek',
            apiKey: deepseekKey,
            baseUrl: read(env, 'DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
            fastModel: read(env, 'LLM_MODEL_FAST') ?? 'deepseek-v4-flash',
            reasoningModel: read(env, 'LLM_MODEL_REASONING') ?? 'deepseek-v4-pro',
          },
  };
}

/**
 * A startup summary safe to print.
 *
 * Reports whether each integration is configured, never what it is configured with. Model
 * names and the Graph version are shown because they are not secret and are the two things
 * most often wrong.
 */
export function describeConfig(config: Config): string {
  const lines = [
    `env=${config.nodeEnv} port=${config.port}`,
    config.whatsapp === null
      ? 'whatsapp: not configured (simulated channel only)'
      : `whatsapp: configured (graph ${config.whatsapp.graphVersion})`,
    config.llm === null ? 'llm: not configured' : `llm: ${config.llm.provider} (${config.llm.fastModel} / ${config.llm.reasoningModel})`,
  ];
  return lines.join('\n  ');
}
