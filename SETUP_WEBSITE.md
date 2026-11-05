# Website setup: GitHub Pages + Google Drive

```
 Member's browser (GitHub Pages site, docs/)                       Lab Google account
 ───────────────────────────────────────────                       ──────────────────────────────
 fills form, adds photo + signature
 card preview drawn in the browser        ── 1. register ──▶  Apps Script (apps_script/Code.gs)
                                          ◀─ ID number ─────    • assigns ID (IITP-CVPR-1001, 1002, …)
 final card drawn with the assigned ID                          • saves photo + signature to Drive
                                          ── 2. card ──────▶    • saves the card to Drive
 member downloads PNG / PDF                                     • logs the row in the Google Sheet
                                                                • emails the card (optional)
```
Everything is free: GitHub Pages hosts the site, and Google Apps Script runs the Drive/Sheet side.
No server is needed. The card is drawn by `docs/card.js`, a JavaScript port of `idcard.py`.

Total time: about 15 minutes.

---

## Part A · Google side (do this with the **lab's Google account**)

1. Open **https://script.google.com** → **New project**. Rename it to `CVPR Lab ID Cards`.
2. Delete everything in `Code.gs`, paste in the contents of **`apps_script/Code.gs`**, and press **Save** (💾).
3. In the function menu at the top, choose **`setup`** → **Run**.
   - Google asks for permission: **Review permissions** → choose the lab account.
   - You'll see "Google hasn't verified this app". That's normal for your own script: **Advanced** → **Go to CVPR Lab ID Cards (unsafe)** → **Allow**.
   - The **Execution log** shows two links: the new Drive folder **CVPR Lab ID Cards** (with `Photos/`, `Signatures/`, `Cards/`) and the **Members** sheet.
4. **Optional settings:** **Project Settings** (⚙️) → **Script properties** → **Add script property**:

   | Property | Example | Meaning |
   |---|---|---|
   | `ACCESS_CODE` | `cvpr2026` | members must type this code (recommended, since the site is public) |
   | `VALID_TILL` | `31-12-2026` | forces this date on every card |
   | `ID_PREFIX` | `IITP-CVPR-` | start of every ID number |
   | `NEXT_ID` | `1001` | next number to hand out (goes up automatically) |
   | `SEND_EMAIL` | `true` / `false` | email the card to the member |
   | `OPEN` | `true` / `false` | open or close registration |

5. Choose **`selfTest`** → **Run**. The log must end with **`SELF-TEST PASSED`**. This checks the Drive and Sheet steps for real.
6. **Deploy** (top right) → **New deployment** → ⚙️ **Select type: Web app**
   - Description: `v1`
   - **Execute as: Me** (the lab account, so files go to its Drive)
   - **Who has access: Anyone** (needed so the GitHub site can reach it; the access code protects it)
   - **Deploy** → copy the **Web app URL**. It ends in `/exec`.
7. Paste that URL into your browser. You should see `{"ok":true,...,"ready":true}`.

> **Changed `Code.gs` later?** Use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
> This keeps the same URL. A "New deployment" would give you a new URL.

**Only lab members (optional):** in the Sheet's **Allowed** tab, list roll numbers in column A. Then only those rolls can register.
Put a number in column B to give a roll a specific ID (e.g. `IITP-CVPR-1645`). Leave the tab empty to allow anyone with the access code.

---

## Part B · GitHub side

1. In the repo, open **`docs/config.js`** → ✏️ edit → paste the URL:
   ```js
   APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfy..../exec",
   ```
   Commit.
2. Repo **Settings → Pages** → **Source: Deploy from a branch** → **Branch: `main`**, folder **`/docs`** → **Save**.
3. After about 1 minute, the site is live at **`https://bibek-cse.github.io/ID_CARD/`**.
   Share this link (and the access code) with lab members.

---

## Day-to-day

| Situation | What to do |
|---|---|
| See all members / cards | open the **Members** sheet (each row links to the photo, signature and card in Drive) |
| Someone made a mistake | they submit the form again with the same roll number: same ID number, files replaced |
| Close registration | Script property `OPEN` = `false` |
| Change the access code | Script property `ACCESS_CODE` (takes effect immediately) |
| Count members | run **`stats`** in Apps Script |
| Restart numbering | set `NEXT_ID` (existing members keep their IDs) |

**Limits (free Google account):** about 100 emails per day (Workspace accounts get more), 6 minutes per request (a card takes a few seconds), and 15 GB of Drive space (one member is about 8 MB).

**Without Google:** leave `APPS_SCRIPT_URL` empty. The site then works on its own: the member types the ID number and downloads the card, and nothing is stored.
