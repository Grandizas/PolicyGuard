# Listing screenshots

Put screenshots here. They are **not** shipped inside the extension — the
`docs` folder is excluded from the package — but they are what the AMO listing
and the repository README use.

Upload them to AMO through the web form on the listing page, not by adding them
to the archive.

## What AMO wants

- **1280 × 800** is the maximum display size and the size to aim for. At other
  sizes, keep a **1.6:1** ratio so nothing is letterboxed.
- **No text baked into the image.** Explain a screenshot in its caption, not by
  annotating the picture.
- There is no hard limit on how many, but each one should show a distinct
  feature. Four good ones beat eight repetitive ones.
- The **first** screenshot is the one most people see. It should show findings
  on a real policy, because that is what the extension is for.

## The set to capture

Take these from the real extension in Firefox, on a real policy page — a
genuine site is more convincing than a fixture.

| File | What it shows |
| --- | --- |
| `01-popup-findings.png` | The popup on a real Terms page: risk pill, concern count, several findings with severity labels |
| `02-panel-on-page.png` | The in-page panel expanded, with a quote visible under a finding |
| `03-signup-warning.png` | The pre-agreement warning on a signup form — "policies you are about to agree to" |
| `04-settings.png` | The settings page, ideally showing the model choice and per-policy cost |

If you only have time for one, make it `01`.

## Reproducible sources

The preview harnesses render the real UI against saved fixtures, which is
useful when a live page will not cooperate:

```bash
npm run serve
```

- `localhost:8765/test/popup-preview.html?fixture=stackoverflow-tos.html&deep=done`
- `localhost:8765/test/ui-preview.html` — buttons for the on-page panel
- `localhost:8765/test/options-preview.html`

Screenshots of the real extension are better where you can get them: the
harness popup is a page, not a real browser popup, so the framing differs.
