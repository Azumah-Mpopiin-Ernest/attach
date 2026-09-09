import { useEffect, useState } from "react";
import ConfirmDialog from "./confirmDialog";
import {
  deleteDocument,
  getCollection,
  updateDocument,
} from "../../src/firebaseData";
import Pagination from "../shared/Pagination";

const PAGE_SIZE = 25;

const ROLE_BADGE = {
  Doctor: "bg-sky-50 text-sky-700 ring-sky-200",
  Officer: "bg-violet-50 text-violet-700 ring-violet-200",
  Admin: "bg-[#2F6F62]/10 text-[#2F6F62] ring-[#2F6F62]/20",
};

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingUser, setPendingUser] = useState(null); // user being toggled
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
  const paginatedUsers = users.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    let active = true;
    getCollection("users")
      .then((nextUsers) => {
        if (!active) return;
        setUsers(nextUsers);
        setLoading(false);
      })
      .catch((snapshotError) => {
        if (!active) return;
        setError(snapshotError.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const applyToggle = () => {
    if (!pendingUser) return;
    updateDocument("users", pendingUser.id, { active: !pendingUser.active })
      .then(async () => {
        setUsers(await getCollection("users", { force: true }));
        setPendingUser(null);
      })
      .catch((writeError) => setError(writeError.message));
  };

  const applyDelete = () => {
    if (!pendingDeleteUser) return;
    deleteDocument("users", pendingDeleteUser.id)
      .then(async () => {
        setUsers(await getCollection("users", { force: true }));
        setPendingDeleteUser(null);
      })
      .catch((writeError) => setError(writeError.message));
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900">Users</h1>
      <p className="mt-1 text-sm text-slate-500">
        Everyone with access to Referral Bridge.
      </p>

      {error && <p className="mt-6 text-sm text-rose-600">{error}</p>}
      <div className="mt-6 overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-[760px] w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium text-right">Actions</th>
              <th className="px-5 py-3 font-medium text-right">Delete</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }, (_, index) => (
                <tr
                  key={`loading-${index}`}
                  className="border-b border-slate-100"
                >
                  <td colSpan={5} className="px-5 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                  </td>
                </tr>
              ))}
            {!loading &&
              paginatedUsers.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-slate-100 last:border-0"
                >
                  <td className="px-5 py-3 font-medium text-slate-800">
                    {user.name ?? user.displayName ?? user.email ?? user.id}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${ROLE_BADGE[user.role]}`}
                    >
                      {user.role ?? "Unknown"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {user.active ? "Active" : "Inactive"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setPendingUser(user)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                        user.active
                          ? "text-rose-700 hover:bg-rose-50"
                          : "text-[#2F6F62] hover:bg-[#2F6F62]/10"
                      }`}
                    >
                      {user.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setPendingDeleteUser(user)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            {!loading && users.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-10 text-center text-slate-400"
                >
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageCount={pageCount}
          onPageChange={setPage}
          total={users.length}
        />
      </div>

      <ConfirmDialog
        open={Boolean(pendingUser)}
        title={
          pendingUser?.active
            ? `Deactivate ${pendingUser?.name}?`
            : `Reactivate ${pendingUser?.name}?`
        }
        description={
          pendingUser?.active
            ? "They'll immediately lose the ability to sign in. Referrals already assigned to them keep their history."
            : "They'll be able to sign in again with their existing credentials."
        }
        confirmLabel={pendingUser?.active ? "Deactivate" : "Reactivate"}
        tone={pendingUser?.active ? "danger" : "default"}
        onConfirm={applyToggle}
        onCancel={() => setPendingUser(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingDeleteUser)}
        title={`Delete ${pendingDeleteUser?.name ?? pendingDeleteUser?.email ?? "this user"}?`}
        description="This removes their Referral Bridge profile and prevents future access. Their Firebase sign-in account may still require separate removal by an administrator in the Firebase Console."
        confirmLabel="Delete user"
        tone="danger"
        onConfirm={applyDelete}
        onCancel={() => setPendingDeleteUser(null)}
      />
    </div>
  );
}
