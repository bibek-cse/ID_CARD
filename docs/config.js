/* ----------------------------------------------------------------------------
 * Site settings - edit these, commit, and GitHub Pages updates automatically.
 * ------------------------------------------------------------------------- */
window.IDCARD_CONFIG = {
  // Web-app URL from Apps Script (Deploy -> Manage deployments), ends with /exec.
  // Leave "" to run without Google Drive (cards are only downloaded, IDs typed by hand).
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwwKpBeiYA2rBaCgdHtg2Kr5UGmU1GomKKGAXuGPzach2useihLslN8CkDh1ZcoODeT9A/exec",

  // Default "Valid till" shown in the form (the Apps Script can override it).
  VALID_TILL: "31-12-2026",

  PROGRAMS: ["B.Tech", "M.Tech", "MS (Research)", "Ph.D.", "M.Sc.", "Dual Degree",
             "Research Intern", "Project Staff"],
};
