globalThis.LA_CONFIG = {
  // ===== FILL THESE IN (then run: node build.mjs) =====
  LHIMS_URL_PATTERNS: ["http://10.10.16.50/lhims_*/*"], // http:// if LHIMS is http
  APP_ORIGINS: ["https://attach-hfch.vercel.app", "http://localhost:5173"],
  // ====================================================

  PAGES: {
    list: "scheduleManager.php",
    update: "updateSchedule.php",
    view: "viewSchedule.php",
  },
  NOTE_TEXT: "Internal Referral Form",
  ATTACHMENT_TYPE_TEXT: "Referral",
  NAME_CHECK: "warn", // "strict" | "warn" | "off"
  VERIFY_BYTES: "warn", // "strict" | "warn" | "off": stored file size vs sent file size
  LINKS_PER_ATTACHMENT: null, // set to 1 or 2 after the first DEBUG save (catches duplicate uploads)

  // Row background classification when a patient has several visits in the results.
  // Hue in degrees, read from the row's computed background colour.
  ROW_COLOR: {
    minChroma: 0.04, // below this = white/grey = "other"
    red: [
      [0, 20],
      [340, 360],
    ], // UNVERIFIED: no red row seen yet
    yellow: [[38, 68]], // measured from screenshot: 55 degrees
    green: [[68, 170]], // measured from screenshot: 83 degrees
  },

  MAX_BYTES: 3 * 1024 * 1024,
  SETTLE_MS: 1500, // quiet period after Search before choosing a row
  STAGE_TIMEOUT_MIN: 2, // watchdog (chrome.alarms) per automatic stage
  VERIFY_TIMEOUT_MIN: 3, // watchdog from Save click to verification
  BREAKER_MAX_FAILS: 3,
  DEBUG: false,

  // Every selector lives here. "ev" = evidence, "WEAK" = not proven.
  SELECTORS: {
    session: { loggedIn: "#logout" }, // ev: outputs 1-5, visible on every logged-in page
    login: { password: 'input[type="password"]' }, // WEAK: no login-page sample yet
    list: {
      patientSelect: "#idPatientSearch", // ev: out2 select2-backed <select>, options "NAME (NO)"
      searchButton: "a#idBtnSearch", // ev: out2
      grid: "#mygrid_datagrid", // ev: out2
      patientLink: "a.classSchedGridDisplayMainBlockName[data-patient-no]", // ev: out2 row HTML
      rowBlock: ".classSchedGridBlockDisplay", // ev: out2 row HTML
      updateIcon: 'a[onclick^="fUpdateSchedule("]', // ev: out2 + your answer (row HTML truncated)
    },
    update: {
      scheduleIdHidden: "#idScheduleID", // ev: out3/4 hidden, name=iScheduleID
      patientName: "#idTabBSCDTLPatientName", // WEAK: visibility unknown
      fileInput: 'input[type="file"][name="idReferralAttachments[]"]', // ev: out3/4
      note: 'textarea[name="idReferralAttachmentsNotes[]"]', // ev: out3/4
      type: 'select[name="idReferralAttachmentsType[]"]', // ev: out3/4 native select
      saveButton: "#isAddSchedule", // ev: out3/4 (NHIA modal behaviour unknown)
    },
    // ev: out5 + screenshot. The file name is NOT shown on the saved page.
    verify: { downloadLink: "a.classDownloadReferralAttachment" },
  },
};
