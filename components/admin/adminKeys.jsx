import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import ConfirmDialog from "./confirmDialog";
import { db } from "../../src/firebase";
import { getCollection, updateDocument } from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;
const MAX_GENERATE_ATTEMPTS = 5;

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const block = () =>
    Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  return `${block()}-${block()}`;
}

const STATUS_LABEL = {
  unused: { text: "Unused", cls: "text-slate-500" },
  used: { text: "Used", cls: "text-emerald-700" },
  revoked: { text: "Revoked", cls: "text-slate-400 line-through" },
};

export default function AdminKeys() {
  const [keys, setKeys] = useState([]);
  const [role, setRole] = useState("doctor");
  const [copiedId, setCopiedId] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(keys.length / PAGE_SIZE));
  const paginatedKeys = keys.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    let active = true;
    getCollection("registrationKeys")
      .then((items) => {
        if (active) setKeys(items.slice().sort(compareCreatedAtDescending));
      })
      .catch((snapshotError) => {
        if (active) setError(snapshotError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  // Keys are now keyed by their own code (see firestore.rules, which relies
  // on registrationKeyId matching the doc ID for the unauthenticated get()
  // lookup during signup). Since we no longer get a Firestore-assigned
  // unique ID for free, check for a collision before writing and just
  // regenerate on the rare case one occurs.
  const handleGenerate = async () => {
    setError("");
    setGenerating(true);
    try {
      let code;
      let exists = true;
      let attempts = 0;

      do {
        code = generateCode();
        const snapshot = await getDoc(doc(db, "registrationKeys", code));
        exists = snapshot.exists();
        attempts += 1;
      } while (exists && attempts < MAX_GENERATE_ATTEMPTS);

      if (exists) {
        throw new Error(
          "Could not generate a unique registration key. Please try again.",
        );
      }

      await setDoc(doc(db, "registrationKeys", code), {
        code,
        role,
        used: false,
        revoked: false,
        createdAt: new Date(),
      });

      setKeys(
        (await getCollection("registrationKeys", { force: true })).sort(
          compareCreatedAtDescending,
        ),
      );
    } catch (writeError) {
      setError(writeError.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = (key) => {
    navigator.clipboard?.writeText(key.code);
    setCopiedId(key.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const applyRevoke = () => {
    if (!pendingRevoke) return;
    updateDocument("registrationKeys", pendingRevoke.id, { revoked: true })
      .then(async () => {
        setKeys(
          (await getCollection("registrationKeys", { force: true })).sort(
            compareCreatedAtDescending,
          ),
        );
        setPendingRevoke(null);
      })
      .catch((writeError) => setError(writeError.message));
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900">
        Registration Keys
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        Only people with a valid key can create an account.
      </p>

      {error && <p className="mt-6 text-sm text-rose-600">{error}</p>}
      <div className="mt-6 flex items-center gap-3 rounded-md border border-slate-200 bg-white p-4">
        <label className="text-sm text-slate-600" htmlFor="key-role">
          Generate new key for
        </label>
        <select
          id="key-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 focus:border-[#2F6F62] focus:outline-none"
        >
          <option value={"doctor"}>Doctor</option>
          <option value={"officer"}>Officer</option>
        </select>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="ml-auto rounded-md bg-[#2F6F62] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#265a50] disabled:opacity-50"
        >
          {generating ? "Generating..." : "Generate"}
        </button>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-[640px] w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-5 py-3 font-medium">Code</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedKeys.map((key) => (
              <tr
                key={key.id}
                className="border-b border-slate-100 last:border-0"
              >
                <td className="px-5 py-3 font-mono text-slate-800">
                  {key.code}
                </td>
                <td className="px-5 py-3 text-slate-600">{key.role}</td>
                <td
                  className={`px-5 py-3 ${STATUS_LABEL[getKeyStatus(key)].cls}`}
                >
                  {STATUS_LABEL[getKeyStatus(key)].text}
                  {getKeyStatus(key) === "used" && key.usedByName && (
                    <span className="text-slate-400"> — {key.usedByName}</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  {getKeyStatus(key) === "unused" && (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(key)}
                        className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                      >
                        {copiedId === key.id ? (
                          <>
                            <Check className="h-3.5 w-3.5" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" /> Copy
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingRevoke(key)}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageCount={pageCount}
          onPageChange={setPage}
          total={keys.length}
        />
      </div>

      <ConfirmDialog
        open={Boolean(pendingRevoke)}
        title={`Revoke key ${pendingRevoke?.code}?`}
        description="Anyone who still has this code won't be able to use it to create an account."
        confirmLabel="Revoke"
        tone="danger"
        onConfirm={applyRevoke}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}

function getKeyStatus(key) {
  if (key.revoked) return "revoked";
  if (key.used) return "used";
  return "unused";
}

function compareCreatedAtDescending(left, right) {
  return toTimestamp(right.createdAt) - toTimestamp(left.createdAt);
}

function toTimestamp(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
