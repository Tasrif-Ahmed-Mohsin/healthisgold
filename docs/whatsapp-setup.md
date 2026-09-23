# Getting WhatsApp Cloud API credentials

There is no single "WhatsApp API key". You end up with **five** values, and they come from
three different screens. That is the main thing that makes this confusing the first time.

| Value | Where it comes from | What it is for |
| --- | --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | App Dashboard → WhatsApp → API Setup | Identifies the number you send *from* |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Same screen | Identifies the WABA, needed for template management |
| `WHATSAPP_ACCESS_TOKEN` | Business Settings → System Users | Authorises API calls |
| `WHATSAPP_APP_SECRET` | App Settings → Basic | Verifies that inbound webhooks really came from Meta |
| `WHATSAPP_VERIFY_TOKEN` | You invent it | One-time handshake when registering the webhook |

## You do not need Business Verification

This is the part worth knowing before you start, because Business Verification in Bangladesh
means trade licence, TIN and supporting documents, and it takes weeks.

Meta gives every new app a **free test phone number** that works immediately. It can message up
to **5 recipient numbers** that you verify by code. For a thesis, a competition demo or a pilot
with a handful of real users, that is enough — and it costs nothing, because test-number
messages are free.

Business Verification only becomes necessary when you want to message people outside that list
of five. Do not start there.

Meta's guided setup will show you three steps — try it out, production setup, business
verification — and the third one asks for documents. That is expected, and it is deliberately
last. The asset tree on that same screen is the giveaway: the **test WABA is tagged Step 1**,
while your own WABA, your own phone number and a **payment method** are all Step 2. Step 2
onwards is the billed production path.

**Do Step 1, then stop.** Steps 2 and 3 exist to get you to "ready to message your own
customers", which is not where a demo or a five-user pilot needs to go.

### Publishing is not verification

These are two different things and Meta's wording blurs them.

- **Publishing** (Development → Live) is a toggle. Its only real prerequisite is a privacy
  policy URL that resolves to a real page. **You do need this** — see step 8.
- **Business Verification** means uploading company documents for review. You do not need it.

You can publish an app without verifying a business.

## Step 1 — Developer account

Register at [developers.facebook.com](https://developers.facebook.com/async/registration/) using
a normal Facebook account. Use a personal account you control; do not create a throwaway, because
losing it means losing the app.

## Step 2 — Create a business portfolio *first*

Do this before creating the app. The app wizard's **Business** step only lists portfolios that
already exist — it will not create one for you, and with none available the **Next** button is
disabled and you are stuck.

A business portfolio is **not** a verified business. Creating one is free, takes two minutes and
needs no documents.

1. Go to [business.facebook.com](https://business.facebook.com) with the same Facebook login.
2. **Create a business portfolio** — or Settings → Business portfolios → Create.
3. Enter a portfolio name, your name and a business email. The name can be anything; it does not
   have to be a registered company.
4. **Click the confirmation link Meta emails you.** An unconfirmed portfolio sometimes fails to
   appear in the app wizard, and the failure looks like a bug rather than a missing step.

## Step 3 — Create the app

1. Go to the [App Dashboard](https://developers.facebook.com/apps) → **Create App**.
2. Give it a name and a contact email.
3. Choose the use case **"Connect with customers through WhatsApp"**. Picking the wrong use case
   here is the most common early mistake — it hides the WhatsApp product from the sidebar.
4. At the **Business** step, select the portfolio from step 2. If the dropdown is empty, reload
   the page: it is populated at page load, so a portfolio created after you opened the wizard
   will not show up until you refresh. Leave it unverified.

## Step 4 — Get the test number and the IDs

In the left sidebar go to **WhatsApp → API Setup**. This screen gives you:

- a **From** dropdown already containing a Meta-provided test number,
- the **Phone number ID** underneath it → `WHATSAPP_PHONE_NUMBER_ID`,
- the **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`.

Under **To**, open **Manage phone number list** and add your own number. It receives a
confirmation code. Add up to five numbers here — these are the only people the test number can
message.

The same screen has a **Generate access token** button. That token lasts **24 hours**. Use it for
your first `curl` and nothing else; it will expire in the middle of a demo otherwise. Step 6
replaces it.

## Step 5 — App secret

**App Settings → Basic → App Secret → Show.** Copy it into `WHATSAPP_APP_SECRET`.

Do not skip this. Meta signs every inbound webhook with it, and this project refuses any webhook
whose signature does not verify. Without that check, anyone who discovers your callback URL can
post fabricated patient messages into a clinical queue — including messages crafted to trip the
safety kernel, or to manipulate the model that reads them.

## Step 6 — A permanent token

The 24-hour token is not usable for anything real.

1. Go to [Business Settings](https://business.facebook.com/settings) → **Users → System Users**.
2. **Add** a system user. Name it something like `healthcare-api`, role **Admin**.
3. **Add Assets** → select your app → enable **Full control**.
4. **Generate New Token** → select your app → tick the scopes **`whatsapp_business_messaging`**
   and **`whatsapp_business_management`**.
5. Set expiry to **Never**.

Copy it immediately into `WHATSAPP_ACCESS_TOKEN`. Meta shows it once and never again.

## Step 7 — Invent a verify token

Any random string. It is not issued by Meta — you make it up, put it in both `.env` and Meta's
webhook form, and Meta echoes it back once to prove the two ends match.

```bash
openssl rand -hex 32
```

## Step 8 — Point the webhook at your machine

Meta only calls **public HTTPS** URLs, so `localhost:3000` will not work. During development,
tunnel it:

```bash
npx localtunnel --port 3000
```

Then in **WhatsApp → Configuration → Webhook → Edit**:

- **Callback URL**: `https://<your-tunnel>/webhooks/whatsapp`
- **Verify token**: the string from step 7

Click **Verify and save**. Meta sends a single `GET` with `hub.challenge`; the server answers it.
If it fails, the server was not running or the verify token does not match on both sides.

Then **Manage** → subscribe to the **`messages`** field. This is easy to miss, and without it the
webhook verifies successfully and then never delivers anything.

### Publish the app, or nothing will arrive

While the app is unpublished, Meta delivers **only** test webhooks fired from the app dashboard.
No real message reaches your endpoint — not even one you send yourself as the app's own admin or
developer. Meta's own documentation is explicit that some webhooks are not sent in Dev mode.

The failure is silent and misleading: the send API returns success, so **accepted does not mean
delivered**. If messages vanish, check the app mode before any other hypothesis — it is not your
code.

To publish: **App settings → Basic**, add a **Privacy Policy URL**, then use the **Publish**
entry in the sidebar. The URL has to resolve to a real page with real content or validation
fails; a GitHub Pages page is sufficient.

This is not Business Verification and does not require any documents.

## Step 9 — Fill in `.env`

```bash
cp .env.example .env
```

Fill in the five values. `.env` is gitignored.

**Do not paste any of these into a chat, a commit, or a screenshot.** If a token is ever exposed,
revoke it in Business Settings → System Users and generate a new one; there is no way to
un-leak it.

## What this costs

Test-number messages are free. On a production number you pay per message:

- **Replies inside 24 hours** of the patient's last message are **free**. This is the service
  window, and it covers the whole of a normal back-and-forth conversation.
- **Anything you initiate outside that window** must be a pre-approved template and is billed.
  From 1 October 2026, Bangladesh moved onto its own rate card at roughly **$0.073 per marketing
  message**, with utility and authentication rates lower.

The design consequence is in [compliance.md](compliance.md): follow-up reminders are the paid
path, so their frequency is a budget decision, and **an emergency escalation must never depend on
a paid template being deliverable**. A RED verdict reaches a human through the coordinator
console and a phone call, not through a message that might silently fail to send.

## Troubleshooting

**"No businesses available" at the Business step, and Next is greyed out.** You have no business
portfolio yet. The wizard only lists existing ones despite the wording on that screen — do step 2,
then reload the wizard page. If it is still empty afterwards: the confirmation email is unclicked,
the Facebook account is too new or restricted, or the tab is logged into a different account than
the one that owns the portfolio.

**Webhook verification fails.** The server is not reachable, or the verify token differs. Check
the tunnel URL is current — free tunnels change their subdomain on restart.

**Verified, but no messages arrive.** Two causes, in this order. The app is still unpublished, so
Meta delivers no production data at all — see step 8. Or you did not subscribe to the `messages`
field.

**The send API returned success but nothing was delivered.** Same cause: an unpublished app.
Accepted is not delivered, and nothing in the API response tells you the difference.

**`(#131030) Recipient phone number not in allowed list`.** Expected on a test number. Add the
recipient under Manage phone number list.

**`(#190) Access token has expired`.** You are still using the 24-hour token. Do step 6.

**Your first message must be a template.** Until the patient messages you first, there is no
24-hour window open, so only a template can be delivered. Meta preloads `hello_world` for this.
