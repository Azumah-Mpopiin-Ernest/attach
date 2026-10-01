import { Folder, FolderOpen } from "lucide-react";

const BUTTON_CLASSES =
  "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400";

// Shows where forms are saved and lets the officer choose or re-allow the
// forms folder. Renders nothing in browsers without folder access, where
// forms simply download as before.
export default function FormsFolderBar({ formsFolder }) {
  const {
    supported,
    loaded,
    hasFolder,
    folderName,
    permission,
    error,
    chooseFolder,
    allowAccess,
  } = formsFolder;

  if (!supported || !loaded) return null;

  const needsAccess = hasFolder && permission !== "granted";
  let tone = "border-slate-200 bg-slate-50";
  if (needsAccess) tone = "border-amber-200 bg-amber-50";

  return (
    <div className={`mb-4 rounded-md border px-4 py-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {hasFolder ? (
            <FolderOpen className="mt-0.5 h-4 w-4 flex-none text-slate-500" />
          ) : (
            <Folder className="mt-0.5 h-4 w-4 flex-none text-slate-500" />
          )}
          <div className="min-w-0 text-slate-600">
            {!hasFolder && (
              <>
                <p className="font-medium text-slate-800">
                  Save forms to a folder
                </p>
                <p className="mt-0.5">
                  Choose a new, empty folder. The app keeps only the current
                  patient's form in it, so LHIMS's file picker can only show
                  the right file. Until you do, forms download as usual.
                </p>
              </>
            )}
            {hasFolder && needsAccess && (
              <p>
                Forms save to{" "}
                <span className="font-medium text-slate-800">
                  {folderName}
                </span>
                . Allow access so they can keep saving there.
              </p>
            )}
            {hasFolder && !needsAccess && (
              <p>
                Forms save to{" "}
                <span className="font-medium text-slate-800">
                  {folderName}
                </span>
                . In LHIMS, click Attach and pick the only file in that folder.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-none flex-wrap gap-2">
          {needsAccess && (
            <button
              type="button"
              onClick={allowAccess}
              className={BUTTON_CLASSES}
            >
              Allow access
            </button>
          )}
          <button
            type="button"
            onClick={chooseFolder}
            className={BUTTON_CLASSES}
          >
            {hasFolder ? "Change folder" : "Choose folder"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
