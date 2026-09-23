# Public pages

Two static pages that need to live at a public URL: a privacy policy and data-deletion
instructions. Meta requires a working privacy policy URL before an app can be published, and the
Personal Data Protection Act, 2026 requires a privacy notice independently of that — so these
exist for the law first and the Meta form second.

No build step, no dependencies. Open either file in a browser to read it.

## Publishing with GitHub Pages

The fastest route to a URL that resolves, which is what Meta validates.

1. Push this repository to GitHub.
2. Repository **Settings → Pages**.
3. Source: **Deploy from a branch**, branch `main`, folder **`/site`**. Save.
4. Wait a minute or two, then confirm both URLs load in a browser:

```
https://<username>.github.io/<repo>/privacy.html
https://<username>.github.io/<repo>/data-deletion.html
```

Meta fetches the privacy policy URL and validates it resolves to a real page. A 404, a redirect
loop, or an empty page fails, and the error message does not say why.

## Where these go in the Meta console

**App settings → Basic:**

| Field | Value |
| --- | --- |
| Privacy policy URL | the `privacy.html` URL |
| User data deletion | choose *Data deletion instructions URL*, then the `data-deletion.html` URL |
| Terms of Service URL | leave blank, or your own page — **not** `facebook.com` |

## Keep them honest

Both pages currently state that this is academic work, not a healthcare service, running on
synthetic data. **That claim has to stop being written there the moment it stops being true.** A
privacy notice that misdescribes what a system does with health data is worse than no notice at
all — see [../docs/compliance.md](../docs/compliance.md) for what else must change before any real
patient contact.

Neither page has been reviewed by a lawyer.
