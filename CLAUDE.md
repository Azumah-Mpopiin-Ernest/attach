# CLAUDE.md

Internal referral-form workflow for Holy Family Hospital, Berekum (HFCH), deployed at `https://attach-hfch.vercel.app`. Patient referrals are imported from Excel, signed by two doctors, assigned to officers, and then attached as JPEG forms to the patient's schedule in **LHIMS**, the hospital's information system on the LAN at `http://10.10.16.50/lhims_*`. A companion Chrome extension (`lhims-assist/`) does the LHIMS attachment manually or fully automatically.

## Commands

```bash
npm install
npm run dev       # Vite dev server (http://localhost:5173)
npm run build     # production build -> dist/
npm run preview
npm run lint      # oxlint (config: .oxlintrc.json, react + oxc plugins)
```

There is no test suite. Check changes with `npm run lint`, `npm run build`, and by running the app.

LHIMS extension: edit `lhims-assist/config.js`, then run `node build.mjs` from inside `lhims-assist/` to regenerate `manifest.json`. Load the folder as an unpacked extension in Chrome 120+.

## Stack

React 19, Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite`), react-router-dom 7 (`HashRouter`), Firebase 12 (Auth + Firestore only; no Cloud Storage), lucide-react icons, recharts, jsPDF, JSZip/fflate, xlsx. Plain JavaScript/JSX, no TypeScript.

## Environment

- `vite.config.js` sets `envDir: "src"`, so Vite reads **`src/.env`**, not the root `.env`. Right now only a root `.env` exists, so a local `npm run dev` starts with Firebase unconfigured unless the file is copied or moved into `src/`. Required keys: `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID`.
- `src/firebase.js` exports `auth`/`db` as `null` when the config is missing. Callers guard with `if (!auth || !db)`.
- Firestore uses a persistent IndexedDB cache with multi-tab support. Offline operation is a real requirement: officers may work on a LAN with no internet. Do not remove that cache or its fallback.
- `firebase.json`, `.firebaserc` and `firestore.rules` exist locally but are gitignored. The rules enforce the role and referral-transition logic described below, so any schema change needs a matching rules change. Rules are published manually in the Firebase console.
- `src/vercel.json` holds the Vercel headers (`/sw.js` is no-cache; `/assets/*` is immutable).

## Layout

```
src/
  index.jsx, App.jsx        HashRouter; routes /, /auth, /admin/*, /doctor/*, /officer/*
  authPage.jsx              auth gate: sign-in/up, loads users/{uid}, routes by role, renders role app
  signIn.jsx, signUp.jsx    sign-up requires a registration key; the role comes from the key
  firebase.js               Firebase init
  firebaseData.js           ALL Firestore data access (cache, subscriptions, transactions, metrics)
  referralForm.js           THE single referral form design (canvas render) + JPEG/PDF/ZIP outputs
  referralImages.js         streaming bulk PNG ZIP export (fflate, File System Access API)
  referralDates.js          grouping by referralDate (the "Date of Admission"), local-time keys
  registerServiceWorker.js  registers public/sw.js in production builds only
  lhims/                    web-app side of the LHIMS extension bridge
components/
  admin/    dashboard, intake (Excel import), users, registration keys, explorer (assign/override)
  doctor/   pending queue + bulk sign, profile/signature capture (doctor/readme is OUT OF DATE)
  officer/  work queue, forms folder, per-referral flow, LHIMS run bar
  shared/   Pagination
lhims-assist/  Chrome MV3 extension (see below)
public/sw.js   offline service worker for the app shell (bump VERSION to bust caches)
```

File names are camelCase (`adminApp.jsx`), and components are default exports in PascalCase. Each role app (`AdminApp`, `DoctorApp`, `OfficerApp`) switches pages with local `activePage` state, not with nested routes. `admin/` and `doctor/` each keep their own copies of `confirmDialog.jsx` and `statusChip.jsx`.

## Roles and referral lifecycle

There are three roles: `admin`, `doctor` and `officer`. Each user's role is stored in `users/{uid}.role`. `AuthPage` sends the user to the matching path and renders that role's app.

1. **Intake (admin):** `adminIntake.jsx` parses an Excel sheet and creates `referrals` docs with `status: "AWAITING_SIGN"` (fields: `patientId`, `name`, `nhis`, `nhiaNo`, `referralDate`, `reason`, `createdAt`). It writes in chunks of 100. The imported files are tracked in `meta/currentImportBatch`.
2. **Signing (doctor):** each referral needs **two different doctors**, one in the "Referred From" slot and one in the "Referred To" slot (`referredFrom*` / `referredTo*` fields: DoctorId, DoctorName, SignatureUrl, SignedAt). Bulk signing (up to 5000 at a time) runs through `updateReferralsTransaction`. `buildSignChanges` in `doctorPending.jsx` re-checks each referral against its current server state and skips any that can no longer be signed. When both slots are filled, the status becomes `READY_TO_ASSIGN`. Signatures are data URLs copied onto every referral, so size limits matter: 1 MiB per doc, 10 MiB / 500 writes per transaction. `statusHistory` is capped at 20 entries.
3. **Assignment (admin):** `adminExplorer.jsx` assigns referrals to an officer. This sets `ASSIGNED` and `assignedTo` = the officer's **fullName**, not their uid. The explorer also provides force unlock, reassign and revert.
4. **Attachment (officer):** `officerApp.jsx` lists the officer's `ASSIGNED` referrals, oldest `referralDate` first. The officer must have that date's patient list open in LHIMS. The form is produced as a JPEG through `renderReferralFormJpegBlob`, which requires the signature images to load, so it never attaches a blank signature. After the officer copies the patient ID and downloads the form, a countdown locks "Mark done" until it expires (`referralFlow.js`).
5. **Completion:** `completeReferral()` **deletes** the referral doc and increments counters in `metrics/batchSummary`, `metricsDaily/{date}`, `officerStats` and `officerDailyStats`. It is offline-friendly: do not `await` it in the UI. Once the `referrals` collection is empty, `resetBatchIfEmpty()` wipes all batch-scoped metrics and meta.

## Data layer conventions (`src/firebaseData.js`)

- Every Firestore read and write goes through this module. It has a per-collection cache (`getCollection`, `invalidateCollection`).
- The project is on the Spark (free) plan, so reads are billed against a daily quota. Use `getReferralCount` (an aggregation query) for badges and tiles instead of fetching documents. When the quota runs out, errors carry `error.quotaExceeded`. Show the user something actionable in that case.
- `subscribeToReferrals({ ..., includeMetadata })` exposes `fromCache`, which the officer screen uses to detect that it is offline.

## Referral form rendering

`renderReferralFormCanvas` in `src/referralForm.js` is the **only** definition of the form's look. It draws a 1600×1067 canvas. The officer JPEG, the admin A4 print-sheet PDFs (4 forms per page, zipped) and the admin PNG ZIP all render through it. Change the design there and nowhere else. Image loads are memoized per URL; failed loads are not cached.

## LHIMS extension (`lhims-assist/`)

- **Bridge:** the app talks to the extension through `window.postMessage`. `src/lhims/lhimsBridge.js` (source `LHIMS_ASSIST_APP`) talks to the extension's `relay.js` content script (source `LHIMS_ASSIST_EXT`). Both sides check the exact origin. `relay.js` allow-lists the message types: `PING`, `GET_STATE`, `SUBMIT_JOB`, `CANCEL_JOB`, `ACK_BREAKER`, `RUN_START` and `RUN_STOP` from the app, and `STATE` and `RUN_REQUEST` back to it. A new message type must be added on both sides.
- **Job:** `src/lhims/lhimsJob.js` builds the job: the form JPEG as base64, plus its size and SHA-256.
- **Run modes:** `useLhimsAutomation` sends one manual job, and the officer clicks Save in LHIMS. `useLhimsRun` drives a full auto run over the queue. A run stops on a hard stop (`LOGGED_OUT`, `EXTENSION_ERROR`) or on `MAX_CONSECUTIVE_PROBLEMS`. A problem with a single referral only skips that referral, and the skip reason is saved in localStorage (`skipNotes.js`) for the Skipped tab.
- **Extension files:** `sw.js` is the background service worker. It handles the job state machine, the tab pool, the circuit breaker and an alarms-based watchdog. `lhims.js` and `badge.js` run on LHIMS pages and drive the DOM using `config.js` `SELECTORS`. `dialogs.js` runs in the page's MAIN world and auto-accepts only the exact `confirm()` texts listed in `AUTO.CONFIRMS`.
- **Config:** `config.js` holds every tunable value: URLs, LHIMS page names, selectors, timeouts, row-colour hue ranges and auto-run settings. `manifest.json` is generated from it by `build.mjs`. Both files are gitignored and exist only locally. Never commit them.
- **App URLs:** the app origins are configured in `config.js`: `https://attach-hfch.vercel.app` and `http://localhost:5173`. Over plain-HTTP LAN origins, `crypto.subtle` is unavailable, so `sha256` is `null` and the extension checks only the length.

## Gotchas

- `components/doctor/readme` describes an older mock design: Cloud Storage, a `READY_TO_ATTACH` status and a `DoctorHistory` page. None of these exist any more. Trust the code.
- `public/sw.js` registers only in production builds. If users see stale clients after a deploy, bump `VERSION` in it.
- Patient data files (`*.xlsx`, form images) are gitignored. Never commit real patient data.
- Officer-flow state (`referralFlow.js`) lives in sessionStorage, and every access is wrapped in try/catch. Keep it that way.
