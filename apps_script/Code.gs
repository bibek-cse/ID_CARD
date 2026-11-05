/**
 * CVPR Lab ID cards - Google Apps Script backend (Google Drive + Sheet).
 *
 * The website (GitHub Pages, docs/) draws the card in the browser. This script:
 *   - assigns each roll number a unique ID number (kept if they submit again)
 *   - saves photo, signature and finished card in Google Drive
 *   - logs every member in a Google Sheet (with links to the files)
 *   - optionally emails the card to the member
 *
 * Setup: see apps_script/SETUP.md  (run setup() once, then Deploy -> Web app).
 *
 * Script properties (Project Settings -> Script properties), all optional:
 *   ACCESS_CODE   lab code people must type on the website ('' = none)
 *   ID_PREFIX     default 'IITP-CVPR-'
 *   NEXT_ID       next number to hand out, default 1001 (increments automatically)
 *   VALID_TILL    e.g. 31-12-2026  -> forced on every card ('' = member chooses)
 *   SEND_EMAIL    'true' (default) / 'false'
 *   OPEN          'true' (default) / 'false'  -> close registration
 */

const ROOT_NAME = 'CVPR Lab ID Cards';
const MEMBERS = 'Members';
const ALLOWED = 'Allowed';
const HEAD = ['Updated', 'Roll', 'Name', 'Program', 'Valid till', 'ID number', 'Barcode', 'Email',
              'Photo', 'Signature', 'Card', 'Status', 'Token', 'First registered'];
const COL = Object.fromEntries(HEAD.map((h, i) => [h, i + 1]));
const ROLL_RE = /^(\d{2})\d*[A-Z]+(\d+)$/;
const DATE_RE = /^(0[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2])-\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PHOTO = 8e6, MAX_SIG = 4e6, MAX_CARD = 16e6;      // base64 characters

/* ------------------------------------------------------------------ setup */
function setup() {
  const p = PropertiesService.getScriptProperties();
  let root = p.getProperty('ROOT_ID') && tryGet_(() => DriveApp.getFolderById(p.getProperty('ROOT_ID')));
  if (!root) { root = DriveApp.createFolder(ROOT_NAME); p.setProperty('ROOT_ID', root.getId()); }
  ['Photos', 'Signatures', 'Cards'].forEach(n => {
    const key = n.toUpperCase() + '_ID';
    if (!(p.getProperty(key) && tryGet_(() => DriveApp.getFolderById(p.getProperty(key))))) {
      p.setProperty(key, root.createFolder(n).getId());
    }
  });
  let ss = p.getProperty('SHEET_ID') && tryGet_(() => SpreadsheetApp.openById(p.getProperty('SHEET_ID')));
  if (!ss) {
    ss = SpreadsheetApp.create('CVPR Lab ID Cards - Members');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    p.setProperty('SHEET_ID', ss.getId());
  }
  let m = ss.getSheetByName(MEMBERS) || ss.getSheets()[0].setName(MEMBERS);
  if (m.getLastRow() === 0) {
    m.appendRow(HEAD); m.setFrozenRows(1);
    m.getRange(1, 1, 1, HEAD.length).setFontWeight('bold').setBackground('#3a0e10').setFontColor('#ffffff');
    m.hideColumns(COL['Token']);
  }
  let a = ss.getSheetByName(ALLOWED);
  if (!a) {
    a = ss.insertSheet(ALLOWED);
    a.appendRow(['Roll', 'ID number (optional)', 'Note']);
    a.getRange(1, 1, 1, 3).setFontWeight('bold');
    a.getRange('A2').setNote('Leave this sheet empty to let anyone register. Add roll numbers here to allow ONLY those. ' +
                             'Fill column B to pre-assign a specific ID number to a roll.');
  }
  const defaults = { ID_PREFIX: 'IITP-CVPR-', NEXT_ID: '1001', SEND_EMAIL: 'true', OPEN: 'true' };
  Object.keys(defaults).forEach(k => { if (p.getProperty(k) === null) p.setProperty(k, defaults[k]); });
  console.log('Drive folder : ' + root.getUrl());
  console.log('Members sheet: ' + ss.getUrl());
  console.log('Next: Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Anyone), ' +
              'then paste the /exec URL into docs/config.js on GitHub.');
}

/* ---------------------------------------------------------------- web app */
function doGet() {
  const p = PropertiesService.getScriptProperties();
  return json_({ ok: true, requireCode: !!p.getProperty('ACCESS_CODE'), validTill: p.getProperty('VALID_TILL') || '',
                 open: (p.getProperty('OPEN') || 'true') !== 'false', ready: !!p.getProperty('SHEET_ID') });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'register') return json_(register_(req));
    if (req.action === 'card') return json_(saveCard_(req));
    return json_({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* -------------------------------------------------------- step 1: register */
function register_(r) {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SHEET_ID')) throw new Error('The lab has not finished setting up (run setup()).');
  if ((p.getProperty('OPEN') || 'true') === 'false') throw new Error('ID card registration is currently closed.');
  const code = p.getProperty('ACCESS_CODE') || '';
  if (code && String(r.code || '').trim() !== code) throw new Error('Wrong lab access code.');

  const roll = String(r.roll || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const m = roll.match(ROLL_RE);
  if (!m || roll.length > 14) throw new Error('Roll number should look like 2601CS45.');
  const name = clean_(r.name, 60), program = clean_(r.program, 30);
  if (!name) throw new Error('Name is required.');
  if (!program) throw new Error('Program is required.');
  const forced = p.getProperty('VALID_TILL') || '';
  const validTill = forced || String(r.validTill || '').trim();
  if (!DATE_RE.test(validTill)) throw new Error('Valid till must be DD-MM-YYYY.');
  const email = String(r.email || '').trim().slice(0, 80);
  if (email && !EMAIL_RE.test(email)) throw new Error('Email address looks wrong.');
  const photo = dataUrl_(r.photo, MAX_PHOTO, 'photo');
  const sig = dataUrl_(r.signature, MAX_SIG, 'signature');
  const barcode = 'IITPCVPR' + m[1] + (m[2].length < 2 ? ('0' + m[2]) : m[2]);

  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
    const sh = ss.getSheetByName(MEMBERS);
    const allowed = allowedMap_(ss);
    if (allowed && !(roll in allowed)) throw new Error('Roll number ' + roll + ' is not on the lab member list. Contact the lab admin.');

    const row = findRow_(sh, roll);
    let idNumber, existing = row > 0, first = new Date();
    if (existing) {
      idNumber = sh.getRange(row, COL['ID number']).getValue();
      first = sh.getRange(row, COL['First registered']).getValue() || first;
    } else if (allowed && allowed[roll]) {
      idNumber = allowed[roll];
    } else {
      const n = parseInt(p.getProperty('NEXT_ID') || '1001', 10);
      idNumber = (p.getProperty('ID_PREFIX') || 'IITP-CVPR-') + n;
      p.setProperty('NEXT_ID', String(n + 1));
    }

    const photoFile = putFile_('PHOTOS_ID', roll + '_photo.' + photo.ext, photo.blob);
    const sigFile = putFile_('SIGNATURES_ID', roll + '_signature.png', sig.blob);
    const token = Utilities.getUuid();
    const values = {
      'Updated': new Date(), 'Roll': roll, 'Name': name, 'Program': program, 'Valid till': validTill,
      'ID number': idNumber, 'Barcode': barcode, 'Email': email, 'Photo': photoFile.getUrl(),
      'Signature': sigFile.getUrl(), 'Card': '', 'Status': 'registered - card pending', 'Token': token,
      'First registered': first,
    };
    writeRow_(sh, existing ? row : sh.getLastRow() + 1, values);
    return { ok: true, idNumber: String(idNumber), barcode: barcode, validTill: validTill, token: token, existing: existing };
  } finally { lock.releaseLock(); }
}

/* --------------------------------------------------- step 2: finished card */
function saveCard_(r) {
  const p = PropertiesService.getScriptProperties();
  const roll = String(r.roll || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const card = dataUrl_(r.card, MAX_CARD, 'card', ['png', 'jpeg']);
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  let email = '', idNumber = '', name = '', file;
  try {
    const sh = SpreadsheetApp.openById(p.getProperty('SHEET_ID')).getSheetByName(MEMBERS);
    const row = findRow_(sh, roll);
    if (row < 1) throw new Error('Register first.');
    if (!r.token || sh.getRange(row, COL['Token']).getValue() !== r.token) throw new Error('This upload is not authorised. Submit the form again.');
    file = putFile_('CARDS_ID', roll + '_IDCard.' + card.ext, card.blob);
    sh.getRange(row, COL['Card']).setValue(file.getUrl());
    sh.getRange(row, COL['Status']).setValue('card saved');
    sh.getRange(row, COL['Token']).setValue('');                    // one upload per registration
    sh.getRange(row, COL['Updated']).setValue(new Date());
    email = sh.getRange(row, COL['Email']).getValue();
    idNumber = sh.getRange(row, COL['ID number']).getValue();
    name = sh.getRange(row, COL['Name']).getValue();
  } finally { lock.releaseLock(); }

  let emailed = false;
  if (email && (p.getProperty('SEND_EMAIL') || 'true') !== 'false' && MailApp.getRemainingDailyQuota() > 0) {
    try {
      MailApp.sendEmail({
        to: email, subject: 'Your CVPR Lab ID card (' + idNumber + ')',
        body: 'Hello ' + name + ',\n\nYour CVPR Lab (IIT Patna) ID card is attached.\nID number: ' + idNumber +
              '\n\nIf any detail is wrong, submit the form again; your ID number stays the same.\n\nCVPR Lab, IIT Patna',
        attachments: [file.getBlob()],
      });
      emailed = true;
    } catch (err) { console.warn('email failed: ' + err); }
  }
  return { ok: true, emailed: emailed };
}

/* --------------------------------------------------------------- helpers */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function tryGet_(f) { try { return f(); } catch (e) { return null; } }
function clean_(s, n) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n); }

function dataUrl_(s, max, what, kinds) {
  kinds = kinds || ['png', 'jpeg'];
  const m = String(s || '').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || kinds.indexOf(m[1]) < 0) throw new Error('The ' + what + ' must be a PNG or JPG image.');
  if (m[2].length > max) throw new Error('The ' + what + ' file is too large.');
  const ext = m[1] === 'jpeg' ? 'jpg' : 'png';
  return { ext: ext, blob: Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], what + '.' + ext) };
}

// replace any older file with the same name, so each roll has one current file per folder
function putFile_(folderKey, name, blob) {
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(folderKey));
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  return folder.createFile(blob.setName(name));
}

function findRow_(sh, roll) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const rolls = sh.getRange(2, COL['Roll'], n, 1).getValues();
  for (let i = 0; i < n; i++) if (String(rolls[i][0]).toUpperCase() === roll) return i + 2;
  return -1;
}

function writeRow_(sh, row, values) {
  sh.getRange(row, 1, 1, HEAD.length).setValues([HEAD.map(h => values[h])]);
}

// null = no restriction; otherwise {ROLL: 'preassigned id' or ''}
function allowedMap_(ss) {
  const a = ss.getSheetByName(ALLOWED);
  if (!a || a.getLastRow() < 2) return null;
  const rows = a.getRange(2, 1, a.getLastRow() - 1, 2).getValues();
  const map = {};
  rows.forEach(r => {
    const k = String(r[0] || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (k) map[k] = String(r[1] || '').trim();
  });
  return Object.keys(map).length ? map : null;
}

/* ------------------------------------------------------------ admin tools */
// Run from the editor: shows how many members and cards there are.
function stats() {
  const p = PropertiesService.getScriptProperties();
  const sh = SpreadsheetApp.openById(p.getProperty('SHEET_ID')).getSheetByName(MEMBERS);
  const rows = Math.max(0, sh.getLastRow() - 1);
  const st = rows ? sh.getRange(2, COL['Status'], rows, 1).getValues().map(r => r[0]) : [];
  console.log('members: ' + rows + ', cards saved: ' + st.filter(s => s === 'card saved').length +
              ', next ID: ' + (p.getProperty('ID_PREFIX') || '') + p.getProperty('NEXT_ID'));
}

// Run from the editor after setup(): registers a test member (roll 9999TS99), saves a tiny
// card, checks the Drive files + Sheet row exist, then removes them. Look at the log.
function selfTest() {
  const p = PropertiesService.getScriptProperties();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const saveNext = p.getProperty('NEXT_ID');
  const reg = register_({ roll: '9999TS99', name: 'Self Test', program: 'Test', validTill: p.getProperty('VALID_TILL') || '31-12-2099',
                          email: '', code: p.getProperty('ACCESS_CODE') || '', photo: png, signature: png });
  console.log('register ok: id=' + reg.idNumber + ' barcode=' + reg.barcode);
  const up = saveCard_({ roll: '9999TS99', token: reg.token, card: png });
  console.log('card saved: ' + up.ok);
  const sh = SpreadsheetApp.openById(p.getProperty('SHEET_ID')).getSheetByName(MEMBERS);
  const row = findRow_(sh, '9999TS99');
  console.log('sheet row: ' + row + ', status: ' + sh.getRange(row, COL['Status']).getValue());
  ['PHOTOS_ID', 'SIGNATURES_ID', 'CARDS_ID'].forEach(k => {
    const it = DriveApp.getFolderById(p.getProperty(k)).searchFiles("title contains '9999TS99'");
    while (it.hasNext()) it.next().setTrashed(true);
  });
  sh.deleteRow(row);
  if (saveNext) p.setProperty('NEXT_ID', saveNext);
  console.log('SELF-TEST PASSED - test row and files removed. Now deploy the web app.');
}
