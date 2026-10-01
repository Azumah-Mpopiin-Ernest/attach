globalThis.LA_CONFIG = {
  // ===== KEEP YOUR REAL VALUES HERE (then run: node build.mjs) =====
  LHIMS_URL_PATTERNS: ["http://10.10.16.50/lhims_*/*"],
  APP_ORIGINS: ["https://attach-hfch.vercel.app", "http://localhost:5173"],
  // =================================================================

  PAGES: {
    filter: "scheduleCalendarFilterSelection.php",
    list: "scheduleManager.php",
    update: "updateSchedule.php",
    view: "viewSchedule.php",
  },
  // What Filter & Lock opens (from your Network capture). {DATE} is DD-MM-YYYY.
  LIST_URL_QUERY:
    "iScheduleManagerView=1&iShowAllPatientAppointments=2&dScheduleDate={DATE}&iSelectedStaffID=&iSpecializationID=&iSuperServiceTypeID=&iSchClinicID=1,0",

  NOTE_TEXT: "Internal Referral Form",
  ATTACHMENT_TYPE_TEXT: "Referral",
  VERIFY_BYTES: "warn", // manual mode only. Auto mode is always strict.
  LINKS_PER_ATTACHMENT: null, // set to 1 or 2 once you know it (catches duplicate uploads)

  ROW_COLOR: {
    minChroma: 0.04,
    red: [
      [0, 20],
      [340, 360],
    ], // UNVERIFIED: no red row seen yet
    yellow: [[38, 68]], // measured: 55 degrees
    green: [[68, 170]], // measured: 83 degrees
  },

  AUTO: {
    POOL_SIZE: 2, // use 2 for the first tests
    CLOSE_POOL_ON_STOP: true, // close the pool tabs after Stop / DONE (kept after a problem)
    ACTIVATE_TAB: true, // bring the claimed tab to the front (avoids background-tab throttling)
    READY_TAB_TIMEOUT_MIN: 6, // stop if no list tab becomes ready for a waiting job
    STOP_IF_NOTE_PRESENT: true, // visit already shows the note text: skip it for review
    // A problem with ONE referral never stops the run: the app skips it with the reason and the run moves on.
    HARD_STOPS: ["LOGGED_OUT", "EXTENSION_ERROR"], // these stop everything; the referral stays in the queue
    BENIGN: ["NO_MATCH", "NO_USABLE_ROW", "ALREADY_ATTACHED"], // expected outcomes: not counted as failures
    MAX_CONSECUTIVE_PROBLEMS: 4, // this many real problems in a row stops the run (systematic fault)
    // Exact dialog texts auto-accepted (lower case, spaces collapsed). Anything else is refused.
    CONFIRMS: [
      "do you really want to update the schedule?",
      "do you really want to save ?",
    ],
  },

  MAX_BYTES: 3 * 1024 * 1024,
  SETTLE_MS: 1500,
  STAGE_TIMEOUT_MIN: 2,
  VERIFY_TIMEOUT_MIN: 3,
  BREAKER_MAX_FAILS: 3,
  DEBUG: false,

  SELECTORS: {
    session: { loggedIn: "#logout" },
    login: { password: 'input[type="password"]' }, // WEAK: no login-page sample yet
    list: {
      patientSelect: "#idPatientSearch",
      searchButton: "a#idBtnSearch",
      grid: "#mygrid_datagrid",
      patientLink: "a.classSchedGridDisplayMainBlockName[data-patient-no]",
      rowBlock: ".classSchedGridBlockDisplay",
      updateIcon: 'a[onclick^="fUpdateSchedule("]',
    },
    update: {
      scheduleIdHidden: "#idScheduleID",
      patientName: "#idTabBSCDTLPatientName", // WEAK: visibility unconfirmed
      fileInput: 'input[type="file"][name="idReferralAttachments[]"]',
      note: 'textarea[name="idReferralAttachmentsNotes[]"]',
      type: 'select[name="idReferralAttachmentsType[]"]',
      saveButton: "#isAddSchedule",
    },
    verify: { downloadLink: "a.classDownloadReferralAttachment" },
  },
};
