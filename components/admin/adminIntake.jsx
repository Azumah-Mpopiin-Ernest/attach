import { useCallback, useRef, useState } from "react";
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import * as XLSX from "xlsx";
import { createDocuments } from "../../src/firebaseData";

// Stages: "select" -> "review" -> "importing" -> "done"
// Replace parseExcelFile / commitBatches with real SheetJS parsing and
// chunked Firestore batched writes (<=450 docs/batch per the build spec).

export default function AdminIntake() {
  const [stage, setStage] = useState("select");
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [validRows, setValidRows] = useState([]);
  const [flaggedRows, setFlaggedRows] = useState([]);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError("");
    setFileName(file.name);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setError("Please upload an Excel workbook or CSV file.");
      return;
    }
    let rows;
    try {
      rows = await parseSpreadsheet(file);
    } catch (parseError) {
      setError(parseError.message);
      setStage("select");
      return;
    }
    const valid = [];
    const flagged = [];
    rows.forEach((row) => {
      if (!row.patientid)
        flagged.push({
          patient: row.name || "(blank)",
          issue: "Missing Patient ID",
        });
      else if (!row.nhis)
        flagged.push({
          patient: row.name || "(blank)",
          issue: "Missing NHIS Number",
        });
      else valid.push(row);
    });
    setValidRows(valid);
    setFlaggedRows(flagged);
    setStage("review");
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      handleFile(e.dataTransfer.files?.[0]);
    },
    [handleFile],
  );

  const startImport = useCallback(() => {
    setStage("importing");
    setProgress(0);
    createDocuments(
      "referrals",
      validRows.map((row) => ({
        patientId: row.patientid,
        name: row.name,
        nhis: row.nhis,
        nhiaNo: row.nhiaNo,
        referralDate: row.referralDate,
        reason: row.reason,
        status: "AWAITING_SIGN",
        createdAt: new Date(),
      })),
    )
      .then(() => {
        setProgress(validRows.length);
        setStage("done");
      })
      .catch((writeError) => {
        setError(writeError.message);
        setStage("review");
      });
  }, [validRows]);

  const reset = () => {
    setStage("select");
    setFileName("");
    setProgress(0);
    setValidRows([]);
    setFlaggedRows([]);
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900">Monthly Intake</h1>
      <p className="mt-1 text-sm text-slate-500">
        Upload the month's Excel claims spreadsheet to create new referrals.
      </p>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {stage === "select" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-16 text-center transition-colors ${
            isDragging
              ? "border-[#2F6F62] bg-[#2F6F62]/5"
              : "border-slate-300 bg-white hover:border-slate-400"
          }`}
        >
          <UploadCloud className="h-8 w-8 text-slate-400" />
          <p className="mt-3 text-sm font-medium text-slate-700">
            Drop your Excel or CSV file here
          </p>
          <p className="text-sm text-slate-400">or click to browse</p>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      )}

      {stage === "review" && (
        <div className="mt-6 rounded-md border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <FileSpreadsheet className="h-4 w-4 text-slate-400" />
            {fileName}
          </div>

          <div className="mt-4 flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {validRows.length.toLocaleString()} rows ready
            </div>
            <div className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              {flaggedRows.length} rows flagged
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-2 font-medium">Patient</th>
                  <th className="px-4 py-2 font-medium">Issue</th>
                </tr>
              </thead>
              <tbody>
                {flaggedRows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-2 font-mono text-slate-700">
                      {row.patient}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{row.issue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-slate-400">
            Flagged rows won't be imported. Fix them in your source file and
            re-upload separately — the valid rows below can go in now.
          </p>

          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Fix and re-upload
            </button>
            <button
              type="button"
              onClick={startImport}
              className="rounded-md bg-[#2F6F62] px-4 py-2 text-sm font-medium text-white hover:bg-[#265a50]"
            >
              Import {validRows.length.toLocaleString()} valid rows
            </button>
          </div>
        </div>
      )}

      {stage === "importing" && (
        <div className="mt-6 rounded-md border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-600">
            Importing… {progress.toLocaleString()} /{" "}
            {validRows.length.toLocaleString()}
          </p>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-[#2F6F62] transition-all"
              style={{
                width: `${validRows.length ? (progress / validRows.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {stage === "done" && (
        <div className="mt-6 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-5">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-emerald-700" />
          <div>
            <p className="text-sm font-medium text-emerald-800">
              {validRows.length.toLocaleString()} referrals imported
            </p>
            <p className="mt-1 text-sm text-emerald-700">
              They now appear in doctors' Pending Signatures lists.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-3 text-sm font-medium text-[#2F6F62] hover:underline"
            >
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

async function parseSpreadsheet(file) {
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: true,
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  const headerIndex = matrix.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return (
      headers.includes("patientname") &&
      headers.includes("patientno") &&
      headers.includes("nhiano") &&
      headers.includes("dateofadmission")
    );
  });

  if (headerIndex < 0) {
    throw new Error(
      "Could not find the required columns: Patient Name, Patient No., NHIA No., and Date of Admission.",
    );
  }

  const headers = matrix[headerIndex].map(normalizeHeader);
  return matrix.slice(headerIndex + 1).map((values) => {
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
    return {
      patientid: firstValue(row, [
        "patientid",
        "patientno",
        "patientnumber",
        "id",
      ]),
      name: firstValue(row, ["name", "patientname", "fullname"]),
      nhis: firstValue(row, [
        "nhis",
        "nhisnumber",
        "nhisno",
        "nhia",
        "nhianumber",
        "nhiano",
      ]),
      nhiaNo: firstValue(row, ["nhia", "nhianumber", "nhiano"]),
      referralDate: firstValue(row, [
        "referraldate",
        "dateofadmission",
        "date",
      ]),
      reason: firstValue(row, ["reason", "referralreason", "diagnosis"]),
    };
  });
}

function normalizeHeader(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function firstValue(row, keys) {
  return (
    keys
      .map((key) => row[key])
      .find((value) => value !== undefined && value !== "") ?? ""
  );
}
