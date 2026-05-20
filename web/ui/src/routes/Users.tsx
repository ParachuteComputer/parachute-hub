/**
 * /admin/users — multi-user Phase 1 admin surface.
 *
 * Design: `parachute.computer/design/2026-05-20-multi-user-phase-1.md`.
 * Tracker: hub#252. PR 2 of 5 in the multi-user chain.
 *
 * Surface:
 *
 *   1. **Users list table.** Username · Assigned vault · Password set ·
 *      Created · Actions. First admin (the wizard / env-seeded
 *      bootstrap row) has the Delete button disabled with a tooltip;
 *      the server enforces the same rail (`first_admin_undeletable`).
 *   2. **Create user form.** Collapsible section below the table.
 *      Username + password + assigned-vault dropdown (fetched on mount
 *      from `/api/users/vaults`). The dropdown's first option is the
 *      synthetic "No restriction (admin-level access)" → maps to
 *      `assignedVault: null`. Subsequent options are vault names from
 *      services.json.
 *   3. **Delete confirmation.** Inline confirm dialog mirroring the
 *      `Permissions.tsx` pattern — click → confirm dialog → DELETE →
 *      refresh.
 *
 * Optimistic-update + rollback-on-error: the create flow follows the
 * `Modules.tsx`-style "fire-and-recover" shape. On submit, the form
 * locks, posts; on success the table refreshes from the server (which
 * is the source of truth for `created_at` ordering); on failure the
 * inline error banner surfaces the server's `error_description` and
 * the form re-opens for retry.
 *
 * Auth: every fetch uses the shared `getHostAdminToken()` flow from
 * `lib/auth.ts` (session cookie → cached `parachute:host:admin` JWT).
 * A 401 surfaces verbatim and the lib helper handles the redirect-to-
 * login on the next mint attempt.
 *
 * Force-change-password redirect copy: when the admin creates a user,
 * the success banner says "they'll be prompted to change their
 * password on first sign-in" — telegraphs PR 3's flow without
 * pretending it exists yet (the bit is persisted now; the redirect
 * lands in PR 3).
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type CreateUserInput,
  HttpError,
  type UserListing,
  createUser,
  deleteUser,
  listUserVaults,
  listUsers,
} from "../lib/api.ts";

/**
 * Server's password-floor. Mirrors `PASSWORD_MIN_LEN` in `users.ts`
 * (PR 1). Client-side check is informational — the server validates
 * regardless, and a discrepancy is a UX bug, not a security one.
 */
const PASSWORD_MIN_LEN = 12;

/**
 * Server's username regex. Mirrors `USERNAME_REGEX` + `USERNAME_MIN_LEN`
 * / `USERNAME_MAX_LEN` from `users.ts`. Same defense-in-depth rationale
 * as the password floor — server is authoritative; client-side check is
 * for fast feedback.
 */
const USERNAME_REGEX = /^[a-z0-9_-]+$/;
const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 32;

interface UsersData {
  users: UserListing[];
  vaults: string[];
}

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; data: UsersData }
  | { kind: "error"; message: string };

type CreateState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "created"; username: string }
  | { kind: "error"; message: string };

type DeleteState =
  | { kind: "idle" }
  | { kind: "confirming"; user: UserListing }
  | { kind: "deleting"; userId: string }
  | { kind: "error"; userId: string; message: string };

interface FormFields {
  username: string;
  password: string;
  /** Empty string = the synthetic "No restriction" sentinel. */
  assignedVault: string;
}

const EMPTY_FORM: FormFields = {
  username: "",
  password: "",
  assignedVault: "",
};

export function Users() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormFields>(EMPTY_FORM);
  const [createState, setCreateState] = useState<CreateState>({ kind: "idle" });
  const [deleteSt, setDeleteSt] = useState<DeleteState>({ kind: "idle" });

  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listUsers(), listUserVaults()])
      .then(([users, vaults]) => {
        if (cancelled) return;
        setState({ kind: "ok", data: { users, vaults } });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  function clientValidate(fields: FormFields): string | null {
    if (fields.username.length < USERNAME_MIN_LEN || fields.username.length > USERNAME_MAX_LEN) {
      return `Username must be ${USERNAME_MIN_LEN}-${USERNAME_MAX_LEN} characters.`;
    }
    if (!USERNAME_REGEX.test(fields.username)) {
      return "Username may only contain lowercase letters, digits, hyphens, and underscores.";
    }
    if (fields.password.length < PASSWORD_MIN_LEN) {
      return `Password must be at least ${PASSWORD_MIN_LEN} characters.`;
    }
    return null;
  }

  async function onSubmitCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const validationError = clientValidate(form);
    if (validationError) {
      setCreateState({ kind: "error", message: validationError });
      return;
    }
    setCreateState({ kind: "submitting" });
    const input: CreateUserInput = {
      username: form.username,
      password: form.password,
      assignedVault: form.assignedVault === "" ? null : form.assignedVault,
    };
    try {
      const created = await createUser(input);
      // Clear the form, surface success, refresh the table from the
      // server (canonical source for created_at ordering + first-admin
      // selector).
      setForm(EMPTY_FORM);
      setCreateState({ kind: "created", username: created.username });
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `Create failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setCreateState({ kind: "error", message });
    }
  }

  async function onConfirmDelete(user: UserListing): Promise<void> {
    setDeleteSt({ kind: "deleting", userId: user.id });
    try {
      await deleteUser(user.id);
      setDeleteSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `Delete failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setDeleteSt({ kind: "error", userId: user.id, message });
    }
  }

  return (
    <div>
      <div className="list-header">
        <h2>Users</h2>
      </div>

      <p className="muted">
        Hub user accounts. Each user can be pinned to a single vault (Phase 1) — the OAuth issuer
        narrows their tokens to <code>vault:&lt;assigned&gt;:*</code> scopes. Users with no
        assignment have admin-level vault access. Admin-created users land with a default password
        and are prompted to change it on first sign-in.
      </p>

      {renderListSection(state, deleteSt, setDeleteSt, onConfirmDelete, () =>
        setReload((n) => n + 1),
      )}

      {state.kind === "ok" && (
        <CreateUserSection
          show={showForm}
          setShow={setShowForm}
          form={form}
          setForm={setForm}
          vaults={state.data.vaults}
          createState={createState}
          setCreateState={setCreateState}
          onSubmit={onSubmitCreate}
        />
      )}
    </div>
  );
}

function renderListSection(
  state: ListState,
  deleteSt: DeleteState,
  setDeleteSt: (s: DeleteState) => void,
  onConfirm: (user: UserListing) => Promise<void>,
  onRetry: () => void,
): React.ReactNode {
  if (state.kind === "loading") {
    return <p className="muted">Loading users…</p>;
  }
  if (state.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load users: <code>{state.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  const { users } = state.data;
  if (users.length === 0) {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No users yet.</p>
        <p className="muted">Click Create User below to invite someone.</p>
      </div>
    );
  }
  // The first row by `created_at ASC` is the wizard / env-seeded admin
  // — the server enforces "first admin can't be deleted." The SPA
  // disables the row's Delete button as a UX hint; the server check
  // is authoritative.
  const firstAdminId = users[0]?.id;
  return (
    <ListRendered
      users={users}
      firstAdminId={firstAdminId}
      deleteSt={deleteSt}
      setDeleteSt={setDeleteSt}
      onConfirm={onConfirm}
    />
  );
}

interface ListRenderedProps {
  users: UserListing[];
  firstAdminId: string | undefined;
  deleteSt: DeleteState;
  setDeleteSt: (s: DeleteState) => void;
  onConfirm: (user: UserListing) => Promise<void>;
}

function ListRendered({
  users,
  firstAdminId,
  deleteSt,
  setDeleteSt,
  onConfirm,
}: ListRenderedProps): React.ReactNode {
  return (
    <div className="user-list" style={{ marginTop: "1rem" }}>
      <table className="user-table">
        <thead>
          <tr>
            <th scope="col">Username</th>
            <th scope="col">Assigned vault</th>
            <th scope="col">Password set</th>
            <th scope="col">Created</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isFirstAdmin = u.id === firstAdminId;
            const isDeleting = deleteSt.kind === "deleting" && deleteSt.userId === u.id;
            const isConfirming = deleteSt.kind === "confirming" && deleteSt.user.id === u.id;
            const rowError =
              deleteSt.kind === "error" && deleteSt.userId === u.id ? deleteSt : null;
            return (
              <tr key={u.id} data-user-id={u.id}>
                <td>
                  <code>{u.username}</code>
                  {isFirstAdmin && (
                    <span className="badge" style={{ marginLeft: "0.5rem" }}>
                      first admin
                    </span>
                  )}
                </td>
                <td>
                  {u.assigned_vault ? (
                    <code>{u.assigned_vault}</code>
                  ) : (
                    <span className="muted" title="No per-vault restriction (admin-level access)">
                      —
                    </span>
                  )}
                </td>
                <td>
                  {u.password_changed ? (
                    <span aria-label="changed">✓</span>
                  ) : (
                    <span className="muted">pending first login</span>
                  )}
                </td>
                <td>
                  <span title={u.created_at}>{formatCreatedAt(u.created_at)}</span>
                </td>
                <td>
                  {isConfirming ? null : (
                    <>
                      {/*
                        Screen-reader description for the disabled
                        first-admin Delete button. `title` is
                        unreliable on disabled buttons in assistive
                        tech; `aria-describedby` to a visually-hidden
                        node is the canonical WAI-ARIA shape. We keep
                        `title` too for sighted hover users.
                      */}
                      {isFirstAdmin && (
                        <span id={`first-admin-tooltip-${u.id}`} className="sr-only">
                          First admin can't be deleted (would self-lock the hub)
                        </span>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        disabled={isFirstAdmin || isDeleting}
                        title={
                          isFirstAdmin
                            ? "First admin can't be deleted (would self-lock the hub)"
                            : undefined
                        }
                        aria-describedby={isFirstAdmin ? `first-admin-tooltip-${u.id}` : undefined}
                        onClick={() => setDeleteSt({ kind: "confirming", user: u })}
                        aria-label={`Delete ${u.username}`}
                      >
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    </>
                  )}
                  {isConfirming && (
                    <dialog
                      open
                      className="error-banner"
                      style={{ marginTop: "0.25rem", background: "var(--bg-warn, #fffbe6)" }}
                      aria-label={`Confirm delete ${u.username}`}
                    >
                      <p>
                        Delete <code>{u.username}</code>? This revokes their tokens, drops their
                        sessions and grants, and removes the account. The audit trail is preserved —
                        tokens stay with <code>revoked_at</code> set, anonymised.
                      </p>
                      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                        <button
                          type="button"
                          className="destructive"
                          onClick={() => {
                            void onConfirm(u);
                          }}
                          disabled={isDeleting}
                        >
                          {isDeleting ? "Deleting…" : "Delete"}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setDeleteSt({ kind: "idle" })}
                          disabled={isDeleting}
                        >
                          Cancel
                        </button>
                      </div>
                    </dialog>
                  )}
                  {rowError && (
                    <div className="error-banner" style={{ marginTop: "0.25rem" }}>
                      <code>{rowError.message}</code>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface CreateUserSectionProps {
  show: boolean;
  setShow: (s: boolean) => void;
  form: FormFields;
  setForm: (f: FormFields) => void;
  vaults: string[];
  createState: CreateState;
  setCreateState: (s: CreateState) => void;
  onSubmit: (e: FormEvent) => Promise<void>;
}

function CreateUserSection({
  show,
  setShow,
  form,
  setForm,
  vaults,
  createState,
  setCreateState,
  onSubmit,
}: CreateUserSectionProps): React.ReactNode {
  const submitting = createState.kind === "submitting";
  return (
    <section style={{ marginTop: "1.5rem" }}>
      {!show ? (
        <button type="button" onClick={() => setShow(true)}>
          Create User
        </button>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} aria-label="Create user">
          <h3>Create user</h3>
          <p>
            <label htmlFor="new-user-username">
              Username{" "}
              <span className="muted">
                ({USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} chars, lowercase letters/digits/hyphens/
                underscores)
              </span>
            </label>
            <br />
            <input
              id="new-user-username"
              type="text"
              required
              autoComplete="off"
              value={form.username}
              minLength={USERNAME_MIN_LEN}
              maxLength={USERNAME_MAX_LEN}
              pattern="[a-z0-9_\-]+"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </p>
          <p>
            <label htmlFor="new-user-password">
              Password <span className="muted">(min {PASSWORD_MIN_LEN} chars)</span>
            </label>
            <br />
            <input
              id="new-user-password"
              type="password"
              required
              autoComplete="new-password"
              value={form.password}
              minLength={PASSWORD_MIN_LEN}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </p>
          <p>
            <label htmlFor="new-user-vault">Assigned vault</label>
            <br />
            <select
              id="new-user-vault"
              value={form.assignedVault}
              onChange={(e) => setForm({ ...form, assignedVault: e.target.value })}
            >
              <option value="">No restriction (admin-level access)</option>
              {vaults.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </p>

          {createState.kind === "error" && (
            <div className="error-banner">
              <code>{createState.message}</code>
            </div>
          )}
          {createState.kind === "created" && (
            <output className="success-banner">
              User <code>{createState.username}</code> created. They'll be prompted to change their
              password on first sign-in.
            </output>
          )}

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create user"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={submitting}
              onClick={() => {
                setShow(false);
                setCreateState({ kind: "idle" });
              }}
            >
              Close
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
