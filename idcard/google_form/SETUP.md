# Google Form → ID card: setup

```
Google Form ──submit──▶ Apps Script (Code.gs) ──POST photo+signature+details──▶ Card API (server/app.py)
                              │                                                    │
                              ◀──────────────────── PNG ID card ───────────────────┘
                              ├─▶ saved in Drive folder "CVPR Lab ID Cards"
                              ├─▶ emailed to the respondent (attachment)
                              └─▶ logged in the "Cards" tab of the response Sheet
```

The card has to be rendered by the Python code, because Google Forms can't run Python. So there are two parts: **(A) host the API**, then **(B) connect the form**.

---

## A. Host the card API (pick one)

Pick a long random key first and use it in both parts, for example: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

### Option 1: Google Cloud Run (recommended: always on, HTTPS, free tier is enough)
From the `idcard/` folder (it must contain `template_base.png`: run `python idcard.py clean --template template_blank.png` first):
```bash
gcloud run deploy cvpr-idcard \
  --source . --region asia-south1 --allow-unauthenticated \
  --memory 1Gi --cpu 1 --timeout 120 \
  --set-env-vars API_KEY=<YOUR_KEY>,DEFAULT_VALID_TILL=31-12-2026
```
The command prints a URL such as `https://cvpr-idcard-xxxx.a.run.app`. That's your **API_URL**.
`--allow-unauthenticated` only means Google lets the request through; every request still needs the `X-API-Key`.

### Option 2: lab server / local machine + Cloudflare Tunnel (quick, no cloud account)
```bash
pip install -r server/requirements.txt
API_KEY=<YOUR_KEY> gunicorn -b 127.0.0.1:8080 -w 2 --timeout 120 server.app:app
# in another terminal (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
cloudflared tunnel --url http://127.0.0.1:8080
```
It prints a public `https://….trycloudflare.com` URL. That's your **API_URL**. A quick tunnel's URL changes on every restart, so use a named tunnel or Cloud Run for long-term use.

Check it: `curl <API_URL>/health` → `{"ok":true,"base_exists":true}`

**Optional, members only:** set `ALLOWED_ROLLS=/path/rolls.txt` (one roll number per line). Cards are then only made for roll numbers on that list.

---

## B. Create the form (Apps Script)

1. Go to **script.google.com** → *New project*. Name it e.g. `CVPR ID Cards`.
   Use the lab's Google account; the form, sheet and cards will belong to it.
2. Replace the contents of `Code.gs` with `google_form/Code.gs` and save.
3. **Project Settings** (gear icon) → **Script properties** → add:
   | Property | Value |
   |---|---|
   | `API_URL` | the URL from part A (no trailing slash) |
   | `API_KEY` | the same key as in part A |
   | `VALID_TILL` | optional, e.g. `31-12-2027` |
4. Back in the editor, select **`setup`** → **Run** → allow the permissions (Forms, Drive, Sheets, Gmail, external requests).
   The **Execution log** shows the form's edit link, share link and sheet link.
5. Open the **form edit link** and add **two "File upload" questions**. Google doesn't allow these to be created by script.
   - Title exactly **`Passport photo`**: Required, *Allow only specific file types* → Image, max 1 file, max size 10 MB
   - Title exactly **`Signature`**: same settings
   (Titles must match exactly; the script finds the answers by title.)
6. Run **`testApi`**. The log should show `health: 200` and `auth check (expect 400, not 401): 400`.
7. Submit the form once yourself. Within about 30 s you should get the card by email, a PNG should appear in the Drive folder **CVPR Lab ID Cards**, and a `SENT` row should be added to the **Cards** sheet.
8. Share the form's **share link** with lab members.

### Recommended settings in the form (Settings tab)
- **Responses → Restrict to users in your organisation** (shown when the form belongs to a Google Workspace account). Otherwise set `ALLOWED_EMAIL_DOMAIN = 'your-domain'` at the top of `Code.gs`.
- File-upload questions require respondents to **sign in with Google**; this is Google's rule and can't be turned off.

---

## Day-to-day
| Situation | What to do |
|---|---|
| Someone's details were wrong | they submit the form again; a new card is generated |
| Server was down, cards failed | fix the server, then run **`retryFailed`** in Apps Script |
| Re-send the latest card | run **`regenerateLatest`** |
| See everything | the **Cards** tab of the response Sheet (status, card link, email) |
| Bad photo or signature | the respondent automatically gets an email with the reason and can resubmit |

Limits: Gmail free accounts can send about 100 emails/day (Workspace about 1,500). Each card PNG is about 5 MB.
