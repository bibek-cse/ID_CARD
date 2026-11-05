/**
 * CVPR Lab ID-card request form  -  Google Apps Script
 *
 * Flow:  Google Form submit  ->  onFormSubmit()  ->  POST to the card API (server/app.py)
 *        ->  PNG saved in Drive folder  ->  emailed to the respondent  ->  logged in the Sheet.
 *
 * Setup (once): see google_form/SETUP.md
 *   1. Project Settings -> Script properties:  API_URL, API_KEY  (VALID_TILL optional)
 *   2. Run setup()      -> creates the form, response sheet, Drive folder and trigger
 *   3. In the form editor add two "File upload" questions titled exactly
 *        Passport photo      and      Signature
 *   4. Run testApi() to check the server is reachable.
 */

const FORM_TITLE   = 'CVPR Lab ID Card Request';
const FOLDER_NAME  = 'CVPR Lab ID Cards';
const Q_NAME       = 'Full name';
const Q_ROLL       = 'Roll number';
const Q_PROGRAM    = 'Program';
const Q_PHOTO      = 'Passport photo';
const Q_SIGNATURE  = 'Signature';
const PROGRAMS     = ['B.Tech', 'M.Tech', 'M.Sc', 'MS (Research)', 'Ph.D.', 'Intern', 'Project Staff'];
const ALLOWED_EMAIL_DOMAIN = '';   // e.g. 'iitp.ac.in' -> only these accounts get a card ('' = anyone)

function props_() { return PropertiesService.getScriptProperties(); }

function config_() {
  const p = props_();
  const url = (p.getProperty('API_URL') || '').replace(/\/+$/, '');
  const key = p.getProperty('API_KEY') || '';
  if (!url || !key) throw new Error('Set API_URL and API_KEY in Project Settings -> Script properties');
  return { url: url, key: key, validTill: p.getProperty('VALID_TILL') || '' };
}

/* ------------------------------------------------------------------ */
/* 1. one-time setup                                                   */
/* ------------------------------------------------------------------ */
function setup() {
  const p = props_();
  let form;
  if (p.getProperty('FORM_ID')) {
    form = FormApp.openById(p.getProperty('FORM_ID'));
  } else {
    form = FormApp.create(FORM_TITLE);
    p.setProperty('FORM_ID', form.getId());
  }

  form.setDescription(
    'Fill in your details to receive your CVPR Lab (IIT Patna) ID card by email.\n' +
    '• Photo: front-facing, plain light background, at least 600 px tall.\n' +
    '• Signature: sign in dark ink on white paper and upload a clear photo or scan.');
  try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); }
  catch (e) { form.setCollectEmail(true); }
  form.setLimitOneResponsePerUser(false);
  form.setConfirmationMessage('Thanks! Your ID card is being generated and will arrive by email in a minute.');

  // remove old text/choice items with our titles so setup() can be re-run safely
  form.getItems().forEach(function (it) {
    if ([Q_NAME, Q_ROLL, Q_PROGRAM].indexOf(it.getTitle()) >= 0) form.deleteItem(it);
  });

  form.addTextItem().setTitle(Q_NAME).setRequired(true)
    .setHelpText('As it should appear on the card, e.g. Akash Rathor')
    .setValidation(FormApp.createTextValidation()
      .setHelpText('Letters, spaces, dots and hyphens only (max 60).')
      .requireTextMatchesPattern("^[A-Za-z][A-Za-z .'\\-]{1,59}$").build());

  form.addTextItem().setTitle(Q_ROLL).setRequired(true)
    .setHelpText('e.g. 2601CS45')
    .setValidation(FormApp.createTextValidation()
      .setHelpText('Format: 4 digits, department letters, student number - e.g. 2601CS45')
      .requireTextMatchesPattern('^\\s*[0-9]{4}[A-Za-z]{2,3}[0-9]{2,3}\\s*$').build());

  form.addMultipleChoiceItem().setTitle(Q_PROGRAM).setRequired(true)
    .setChoiceValues(PROGRAMS).showOtherOption(true);

  // response sheet
  let ssId = p.getProperty('SHEET_ID');
  if (!ssId) {
    const ss = SpreadsheetApp.create(FORM_TITLE + ' (responses)');
    ssId = ss.getId();
    p.setProperty('SHEET_ID', ssId);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, ssId);
  }
  const log = logSheet_();

  // Drive folder for generated cards
  folder_();

  // trigger (only one)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();

  Logger.log('Form (edit):  ' + form.getEditUrl());
  Logger.log('Form (share): ' + form.getPublishedUrl());
  Logger.log('Responses:    ' + SpreadsheetApp.openById(ssId).getUrl());
  Logger.log('NOW add two "File upload" questions in the form editor titled exactly: "' +
             Q_PHOTO + '" and "' + Q_SIGNATURE + '" (1 file each, images only, required).');
}

function folder_() {
  const p = props_();
  const id = p.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(FOLDER_NAME);
  p.setProperty('FOLDER_ID', f.getId());
  return f;
}

function logSheet_() {
  const ss = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
  let sh = ss.getSheetByName('Cards');
  if (!sh) {
    sh = ss.insertSheet('Cards');
    sh.appendRow(['Timestamp', 'Email', 'Name', 'Roll', 'Program', 'Status', 'Card file', 'Response ID']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* 2. on every submission                                              */
/* ------------------------------------------------------------------ */
function onFormSubmit(e) {
  processResponse_(e.response);
}

function processResponse_(resp) {
  const email = resp.getRespondentEmail();
  const ans = {};
  resp.getItemResponses().forEach(function (ir) { ans[ir.getItem().getTitle()] = ir.getResponse(); });

  const name = String(ans[Q_NAME] || '').trim();
  const roll = String(ans[Q_ROLL] || '').replace(/\s+/g, '').toUpperCase();
  const program = String(ans[Q_PROGRAM] || '').trim();
  const log = logSheet_();

  try {
    if (ALLOWED_EMAIL_DOMAIN && !String(email).toLowerCase().endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
      throw new Error('Cards are only issued to @' + ALLOWED_EMAIL_DOMAIN + ' accounts.');
    }
    const photo = fileBlob_(ans[Q_PHOTO], 'photo');
    const sig = fileBlob_(ans[Q_SIGNATURE], 'signature');
    const cfg = config_();

    const payload = { name: name, roll: roll, program: program, photo: photo, signature: sig };
    if (cfg.validTill) payload.valid_till = cfg.validTill;

    const r = UrlFetchApp.fetch(cfg.url + '/generate', {
      method: 'post', payload: payload, headers: { 'X-API-Key': cfg.key },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) {
      let msg = r.getContentText();
      try { msg = JSON.parse(msg).error; } catch (x) {}
      throw new Error(msg || ('server returned ' + r.getResponseCode()));
    }

    const card = r.getBlob().setName(roll + '_IDCard.png');
    const file = folder_().createFile(card);

    MailApp.sendEmail({
      to: email,
      subject: 'Your CVPR Lab ID card (' + roll + ')',
      htmlBody: 'Hi ' + name + ',<br><br>Your CVPR Lab, IIT Patna ID card is attached.' +
                '<br><br>If any detail is wrong, submit the form again with the correct details.' +
                '<br><br>CVPR Lab, IIT Patna',
      attachments: [card]
    });
    log.appendRow([new Date(), email, name, roll, program, 'SENT', file.getUrl(), resp.getId()]);
  } catch (err) {
    log.appendRow([new Date(), email, name, roll, program, 'ERROR: ' + err.message, '', resp.getId()]);
    if (email) {
      MailApp.sendEmail(email, 'CVPR Lab ID card - could not be generated',
        'Hi ' + name + ',\n\nWe could not generate your ID card:\n  ' + err.message +
        '\n\nPlease submit the form again after fixing this.\n\nCVPR Lab, IIT Patna');
    }
  }
}

function fileBlob_(answer, label) {
  const ids = Array.isArray(answer) ? answer : (answer ? [answer] : []);
  if (!ids.length) throw new Error('No ' + label + ' was uploaded.');
  const f = DriveApp.getFileById(ids[0]);
  const mt = f.getMimeType();
  if (mt.indexOf('image/') !== 0) throw new Error('The ' + label + ' must be an image (got ' + mt + ').');
  return f.getBlob().setName(label + '.' + (mt.split('/')[1] || 'png'));
}

/* ------------------------------------------------------------------ */
/* 3. utilities                                                        */
/* ------------------------------------------------------------------ */
/** Check the card server is reachable and the key is accepted. */
function testApi() {
  const cfg = config_();
  const h = UrlFetchApp.fetch(cfg.url + '/health', { muteHttpExceptions: true });
  Logger.log('health: ' + h.getResponseCode() + ' ' + h.getContentText());
  const r = UrlFetchApp.fetch(cfg.url + '/generate', {
    method: 'post', payload: { name: 'x' }, headers: { 'X-API-Key': cfg.key }, muteHttpExceptions: true });
  Logger.log('auth check (expect 400, not 401): ' + r.getResponseCode() + ' ' + r.getContentText());
}

/** Re-run the most recent submission (e.g. after the server was down). */
function regenerateLatest() {
  const rs = FormApp.openById(props_().getProperty('FORM_ID')).getResponses();
  if (rs.length) processResponse_(rs[rs.length - 1]);
}

/** Re-run every submission whose status in the Cards sheet starts with ERROR. */
function retryFailed() {
  const form = FormApp.openById(props_().getProperty('FORM_ID'));
  const rows = logSheet_().getDataRange().getValues().slice(1);
  const sent = {}, failed = {};
  rows.forEach(function (r) { if (r[5] === 'SENT') sent[r[7]] = 1; else failed[r[7]] = 1; });
  Object.keys(failed).forEach(function (id) {
    if (!sent[id]) { try { processResponse_(form.getResponse(id)); } catch (e) { Logger.log(id + ': ' + e); } }
  });
}
