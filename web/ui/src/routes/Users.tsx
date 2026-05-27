/**
 * /admin/users — multi-user admin surface (Phase 1 list/create/delete,
 * Phase 2 PR 1 admin password reset, Phase 2 PR 2 multi-vault membership).
 *
 * Design: `parachute.computer/design/2026-05-20-multi-user-phase-1.md`.
 * Tracker: hub#252. Phase 2 PR 2 lifts the single-vault `assignedVault`
 * shape to N-vault membership via the `user_vaults` join table — a user
 * can have access to multiple vaults (e.g. personal + family).
 *
 * Surface:
 *
 *   1. **Users list table.** Username · Assigned vaults · Password set ·
 *      Created · Actions. First admin (the wizard / env-seeded
 *      bootstrap row) has every row action disabled with a tooltip; the
 *      server enforces every rail (`first_admin_undeletable`,
 *      `cannot_reset_first_admin`, `cannot_edit_first_admin_vaults`).
 *   2. **Create user form.** Collapsible section below the table.
 *      Username + password + assigned-vaults multi-select (fetched on
 *      mount from `/api/users/vaults`). `<select multiple>` with shift-
 *      click semantics; selected names render as chips above the
 *      control. Empty selection → no narrowing.
 *   3. **Edit vaults (Phase 2 PR 2).** Per-row inline form mirroring the
 *      reset-password inline shape. Multi-select pre-populated with the
 *      user's current assignments; submit PATCHes /api/users/:id/vaults.
 *   4. **Delete confirmation.** Inline confirm dialog mirroring the
 *      `Permissions.tsx` pattern.
 *   5. **Reset Password (Phase 2 PR 1).** Per-row inline form. Single
 *      password field; success surfaces a row-scoped banner.
 *
 * Optimistic-update + rollback-on-error: the create + reset flows follow
 * the `Modules.tsx`-style "fire-and-recover" shape. On submit, the form
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
 * Force-change-password redirect copy: when the admin creates a user
 * OR resets one, the success banner says "they'll be prompted to
 * change it on first sign-in" — same wording across both flows so the
 * operator builds a consistent mental model.
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
  resetUserPassword,
  updateUserVaults,
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

/**
 * Per-row reset-password state. Only one row can be in the "open form"
 * state at a time (matches Delete's confirm-dialog discipline) — the
 * row's userId carries the open form, all other rows render the
 * collapsed Reset Password button.
 */
type ResetState =
  | { kind: "idle" }
  | { kind: "open"; userId: string; password: string }
  | { kind: "submitting"; userId: string; password: string }
  | { kind: "done"; userId: string; username: string }
  | { kind: "error"; userId: string; password: string; message: string };

interface FormFields {
  username: string;
  password: string;
  /** Selected vault names. Empty array = no narrowing (admin posture). */
  assignedVaults: string[];
}

const EMPTY_FORM: FormFields = {
  username: "",
  password: "",
  assignedVaults: [],
};

/**
 * Per-row Edit-vaults state. Same one-row-at-a-time pattern as the
 * Delete + Reset password flows — only one row can have an open form
 * at any time.
 */
type EditVaultsState =
  | { kind: "idle" }
  | { kind: "open"; userId: string; selected: string[] }
  | { kind: "submitting"; userId: string; selected: string[] }
  | { kind: "done"; userId: string; username: string }
  | { kind: "error"; userId: string; selected: string[]; message: string };

export function Users() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormFields>(EMPTY_FORM);
  const [createState, setCreateState] = useState<CreateState>({ kind: "idle" });
  const [deleteSt, setDeleteSt] = useState<DeleteState>({ kind: "idle" });
  const [resetSt, setResetSt] = useState<ResetState>({ kind: "idle" });
  const [editVaultsSt, setEditVaultsSt] = useState<EditVaultsState>({ kind: "idle" });

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
      assignedVaults: form.assignedVaults,
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

  async function onSubmitEditVaults(user: UserListing, selected: string[]): Promise<void> {
    setEditVaultsSt({ kind: "submitting", userId: user.id, selected });
    try {
      await updateUserVaults(user.id, selected);
      setEditVaultsSt({ kind: "done", userId: user.id, username: user.username });
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `Edit vaults failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setEditVaultsSt({ kind: "error", userId: user.id, selected, message });
    }
  }

  async function onSubmitReset(user: UserListing, password: string): Promise<void> {
    // Client-side password floor — same shape as the create form's
    // validator. Server is authoritative; this is the fast-feedback
    // copy so the operator doesn't burn a roundtrip on an obvious typo.
    if (password.length < PASSWORD_MIN_LEN) {
      setResetSt({
        kind: "error",
        userId: user.id,
        password,
        message: `Password must be at least ${PASSWORD_MIN_LEN} characters.`,
      });
      return;
    }
    setResetSt({ kind: "submitting", userId: user.id, password });
    try {
      await resetUserPassword(user.id, password);
      setResetSt({ kind: "done", userId: user.id, username: user.username });
      // Refresh so the row's "Password set" cell flips back to
      // "pending first login" — the server flipped password_changed
      // back to false, and the table needs to mirror that.
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `Reset failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setResetSt({ kind: "error", userId: user.id, password, message });
    }
  }

  return (
    <div data-route-content="true">
      <div className="list-header">
        <h1>Users</h1>
      </div>

      <p className="muted">
        Hub user accounts. Each user can be a member of one or more vaults — the OAuth issuer
        narrows their tokens to <code>vault:&lt;assigned&gt;:*</code> scopes for any vault in their
        list. Users with no assignments can't authorize any vault yet — assign at least one above.
        The first admin is unrestricted (admin posture). Admin-created users land with a default
        password and are prompted to change it on first sign-in.
      </p>

      {renderListSection(
        state,
        deleteSt,
        setDeleteSt,
        onConfirmDelete,
        resetSt,
        setResetSt,
        onSubmitReset,
        editVaultsSt,
        setEditVaultsSt,
        onSubmitEditVaults,
        state.kind === "ok" ? state.data.vaults : [],
        () => setReload((n) => n + 1),
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
  onConfirmDelete: (user: UserListing) => Promise<void>,
  resetSt: ResetState,
  setResetSt: (s: ResetState) => void,
  onSubmitReset: (user: UserListing, password: string) => Promise<void>,
  editVaultsSt: EditVaultsState,
  setEditVaultsSt: (s: EditVaultsState) => void,
  onSubmitEditVaults: (user: UserListing, selected: string[]) => Promise<void>,
  availableVaults: string[],
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
  // — the server enforces "first admin can't be deleted" AND "first
  // admin password reset goes through /account/change-password
  // directly." The SPA disables both row actions as a UX hint; the
  // server checks are authoritative.
  const firstAdminId = users[0]?.id;
  return (
    <ListRendered
      users={users}
      firstAdminId={firstAdminId}
      deleteSt={deleteSt}
      setDeleteSt={setDeleteSt}
      onConfirmDelete={onConfirmDelete}
      resetSt={resetSt}
      setResetSt={setResetSt}
      onSubmitReset={onSubmitReset}
      editVaultsSt={editVaultsSt}
      setEditVaultsSt={setEditVaultsSt}
      onSubmitEditVaults={onSubmitEditVaults}
      availableVaults={availableVaults}
    />
  );
}

interface ListRenderedProps {
  users: UserListing[];
  firstAdminId: string | undefined;
  deleteSt: DeleteState;
  setDeleteSt: (s: DeleteState) => void;
  onConfirmDelete: (user: UserListing) => Promise<void>;
  resetSt: ResetState;
  setResetSt: (s: ResetState) => void;
  onSubmitReset: (user: UserListing, password: string) => Promise<void>;
  editVaultsSt: EditVaultsState;
  setEditVaultsSt: (s: EditVaultsState) => void;
  onSubmitEditVaults: (user: UserListing, selected: string[]) => Promise<void>;
  availableVaults: string[];
}

function ListRendered({
  users,
  firstAdminId,
  deleteSt,
  setDeleteSt,
  onConfirmDelete,
  resetSt,
  setResetSt,
  onSubmitReset,
  editVaultsSt,
  setEditVaultsSt,
  onSubmitEditVaults,
  availableVaults,
}: ListRenderedProps): React.ReactNode {
  return (
    <div className="user-list" style={{ marginTop: "1rem" }}>
      <div className="table-scroll">
        <table className="user-table">
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Assigned vaults</th>
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
              const rowDeleteError =
                deleteSt.kind === "error" && deleteSt.userId === u.id ? deleteSt : null;
              const resetForRow =
                (resetSt.kind === "open" ||
                  resetSt.kind === "submitting" ||
                  resetSt.kind === "error") &&
                resetSt.userId === u.id
                  ? resetSt
                  : null;
              const resetDone = resetSt.kind === "done" && resetSt.userId === u.id ? resetSt : null;
              const editVaultsForRow =
                (editVaultsSt.kind === "open" ||
                  editVaultsSt.kind === "submitting" ||
                  editVaultsSt.kind === "error") &&
                editVaultsSt.userId === u.id
                  ? editVaultsSt
                  : null;
              const editVaultsDone =
                editVaultsSt.kind === "done" && editVaultsSt.userId === u.id ? editVaultsSt : null;
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
                    {u.assigned_vaults.length > 0 ? (
                      <span
                        style={{
                          display: "inline-flex",
                          flexWrap: "wrap",
                          gap: "0.25rem",
                        }}
                      >
                        {u.assigned_vaults.map((v) => (
                          <code key={v}>{v}</code>
                        ))}
                      </span>
                    ) : (
                      <span
                        className="muted"
                        title={
                          isFirstAdmin
                            ? "First admin is unrestricted (admin posture)"
                            : "No vaults assigned — user can't authorize any vault yet"
                        }
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    {u.password_changed ? (
                      <span aria-label="changed">✓</span>
                    ) : (
                      // Pending-first-login badge (Phase 2 PR 1 polish).
                      // Same `.status status-pending` shape Modules.tsx
                      // uses for its supervisor "pending" rows — keeps
                      // the visual vocabulary consistent across admin
                      // surfaces. The wrapper `span.muted` preserves the
                      // pre-PR-1 prose (`pending first login`) for
                      // accessible-text + existing test selectors; the
                      // status pill draws the operator's eye.
                      <span
                        className="status status-pending"
                        title="User hasn't completed first-sign-in change-password yet"
                      >
                        pending first login
                      </span>
                    )}
                  </td>
                  <td>
                    <span title={u.created_at}>{formatCreatedAt(u.created_at)}</span>
                  </td>
                  <td>
                    {isConfirming ? null : (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.5rem",
                          alignItems: "center",
                        }}
                      >
                        {/*
                        Screen-reader description nodes for both
                        first-admin-disabled buttons. `title` is
                        unreliable on disabled buttons in assistive
                        tech; `aria-describedby` to a visually-hidden
                        node is the canonical WAI-ARIA shape. We keep
                        `title` too for sighted hover users.
                      */}
                        {isFirstAdmin && (
                          <>
                            <span id={`first-admin-tooltip-${u.id}`} className="sr-only">
                              First admin can't be deleted (would self-lock the hub)
                            </span>
                            <span id={`first-admin-reset-tooltip-${u.id}`} className="sr-only">
                              First admin uses /account/change-password directly
                            </span>
                            <span id={`first-admin-vaults-tooltip-${u.id}`} className="sr-only">
                              First admin's vault membership is unrestricted by design
                            </span>
                          </>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            isFirstAdmin ||
                            editVaultsForRow !== null ||
                            (editVaultsSt.kind === "submitting" && editVaultsSt.userId === u.id)
                          }
                          title={
                            isFirstAdmin
                              ? "First admin's vault membership is unrestricted by design"
                              : undefined
                          }
                          aria-describedby={
                            isFirstAdmin ? `first-admin-vaults-tooltip-${u.id}` : undefined
                          }
                          onClick={() =>
                            setEditVaultsSt({
                              kind: "open",
                              userId: u.id,
                              selected: [...u.assigned_vaults],
                            })
                          }
                          aria-label={`Edit vaults for ${u.username}`}
                        >
                          Edit vaults
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            isFirstAdmin ||
                            resetForRow !== null ||
                            (resetSt.kind === "submitting" && resetSt.userId === u.id)
                          }
                          title={
                            isFirstAdmin
                              ? "First admin uses /account/change-password directly"
                              : undefined
                          }
                          aria-describedby={
                            isFirstAdmin ? `first-admin-reset-tooltip-${u.id}` : undefined
                          }
                          onClick={() => setResetSt({ kind: "open", userId: u.id, password: "" })}
                          aria-label={`Reset password for ${u.username}`}
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={isFirstAdmin || isDeleting}
                          title={
                            isFirstAdmin
                              ? "First admin can't be deleted (would self-lock the hub)"
                              : undefined
                          }
                          aria-describedby={
                            isFirstAdmin ? `first-admin-tooltip-${u.id}` : undefined
                          }
                          onClick={() => setDeleteSt({ kind: "confirming", user: u })}
                          aria-label={`Delete ${u.username}`}
                        >
                          {isDeleting ? "Deleting…" : "Delete"}
                        </button>
                      </div>
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
                          sessions and grants, and removes the account. The audit trail is preserved
                          — tokens stay with <code>revoked_at</code> set, anonymised.
                        </p>
                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                          <button
                            type="button"
                            className="destructive"
                            onClick={() => {
                              void onConfirmDelete(u);
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
                    {rowDeleteError && (
                      <div className="error-banner" style={{ marginTop: "0.25rem" }}>
                        <code>{rowDeleteError.message}</code>
                      </div>
                    )}
                    {resetForRow && (
                      <ResetPasswordRowForm
                        user={u}
                        state={resetForRow}
                        onCancel={() => setResetSt({ kind: "idle" })}
                        onPasswordChange={(password) =>
                          setResetSt({ kind: "open", userId: u.id, password })
                        }
                        onSubmit={(password) => {
                          void onSubmitReset(u, password);
                        }}
                      />
                    )}
                    {resetDone && (
                      <output
                        className="success-banner"
                        style={{ marginTop: "0.25rem", display: "block" }}
                      >
                        Password reset for <code>{resetDone.username}</code>. Hand them the new
                        password and tell them they'll be prompted to change it on first sign-in.
                        <div className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
                          Their existing tokens are revoked. Resource servers (vault, scribe, etc.)
                          cache the revocation list for up to 60 seconds — if you're resetting
                          because of a suspected compromise, also restart the affected services
                          (e.g. <code>parachute restart vault</code>) to flush their cache
                          immediately.
                        </div>
                        <div style={{ marginTop: "0.5rem" }}>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setResetSt({ kind: "idle" })}
                          >
                            Dismiss
                          </button>
                        </div>
                      </output>
                    )}
                    {editVaultsForRow && (
                      <EditVaultsRowForm
                        user={u}
                        state={editVaultsForRow}
                        availableVaults={availableVaults}
                        onCancel={() => setEditVaultsSt({ kind: "idle" })}
                        onSelectedChange={(selected) =>
                          setEditVaultsSt({ kind: "open", userId: u.id, selected })
                        }
                        onSubmit={(selected) => {
                          void onSubmitEditVaults(u, selected);
                        }}
                      />
                    )}
                    {editVaultsDone && (
                      <output
                        className="success-banner"
                        style={{ marginTop: "0.25rem", display: "block" }}
                      >
                        Vault assignments updated for <code>{editVaultsDone.username}</code>.
                        <div style={{ marginTop: "0.5rem" }}>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setEditVaultsSt({ kind: "idle" })}
                          >
                            Dismiss
                          </button>
                        </div>
                      </output>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ResetPasswordRowFormProps {
  user: UserListing;
  state:
    | { kind: "open"; userId: string; password: string }
    | { kind: "submitting"; userId: string; password: string }
    | { kind: "error"; userId: string; password: string; message: string };
  onCancel: () => void;
  onPasswordChange: (password: string) => void;
  onSubmit: (password: string) => void;
}

function ResetPasswordRowForm({
  user,
  state,
  onCancel,
  onPasswordChange,
  onSubmit,
}: ResetPasswordRowFormProps): React.ReactNode {
  const submitting = state.kind === "submitting";
  const errorMsg = state.kind === "error" ? state.message : null;
  // Stable input id per row — the lookup-by-label test queries
  // "New temporary password for alice" so each row's input is
  // disambiguated even when multiple rows render forms in test.
  const inputId = `reset-password-input-${user.id}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(state.password);
      }}
      aria-label={`Reset password for ${user.username}`}
      style={{
        marginTop: "0.5rem",
        padding: "0.5rem",
        background: "var(--bg-soft, #f5f5f5)",
        borderRadius: "4px",
      }}
    >
      <p style={{ margin: 0 }}>
        <label htmlFor={inputId}>
          New temporary password for <code>{user.username}</code>{" "}
          <span className="muted">(min {PASSWORD_MIN_LEN} chars)</span>
        </label>
        <br />
        <input
          id={inputId}
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LEN}
          value={state.password}
          disabled={submitting}
          onChange={(e) => onPasswordChange(e.target.value)}
        />
      </p>
      {errorMsg && (
        <div className="error-banner" style={{ marginTop: "0.25rem" }}>
          <code>{errorMsg}</code>
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button type="submit" disabled={submitting}>
          {submitting ? "Setting…" : "Set new password"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface EditVaultsRowFormProps {
  user: UserListing;
  state:
    | { kind: "open"; userId: string; selected: string[] }
    | { kind: "submitting"; userId: string; selected: string[] }
    | { kind: "error"; userId: string; selected: string[]; message: string };
  availableVaults: string[];
  onCancel: () => void;
  onSelectedChange: (selected: string[]) => void;
  onSubmit: (selected: string[]) => void;
}

function EditVaultsRowForm({
  user,
  state,
  availableVaults,
  onCancel,
  onSelectedChange,
  onSubmit,
}: EditVaultsRowFormProps): React.ReactNode {
  const submitting = state.kind === "submitting";
  const errorMsg = state.kind === "error" ? state.message : null;
  const selectId = `edit-vaults-select-${user.id}`;
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = Array.from(e.target.selectedOptions).map((o) => o.value);
    onSelectedChange(next);
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(state.selected);
      }}
      aria-label={`Edit vaults for ${user.username}`}
      style={{
        marginTop: "0.5rem",
        padding: "0.5rem",
        background: "var(--bg-soft, #f5f5f5)",
        borderRadius: "4px",
      }}
    >
      <p style={{ margin: 0 }}>
        <label htmlFor={selectId}>
          Vault assignments for <code>{user.username}</code>{" "}
          <span className="muted">(empty = no narrowing; shift-click to multi-select)</span>
        </label>
      </p>
      {state.selected.length > 0 && (
        <div
          data-testid={`edit-vaults-chips-${user.id}`}
          style={{
            marginTop: "0.4rem",
            display: "flex",
            flexWrap: "wrap",
            gap: "0.25rem",
          }}
        >
          {state.selected.map((v) => (
            <code key={v} style={{ padding: "0.1rem 0.4rem", borderRadius: "4px" }}>
              {v}
            </code>
          ))}
        </div>
      )}
      <select
        id={selectId}
        multiple
        value={state.selected}
        onChange={handleChange}
        disabled={submitting}
        size={Math.min(Math.max(availableVaults.length, 3), 8)}
        style={{ marginTop: "0.4rem", minWidth: "12rem" }}
      >
        {availableVaults.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {availableVaults.length === 0 && (
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          No vaults registered on this hub yet.
        </p>
      )}
      {errorMsg && (
        <div className="error-banner" style={{ marginTop: "0.25rem" }}>
          <code>{errorMsg}</code>
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save vault assignments"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
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
            <label htmlFor="new-user-vaults">
              Assigned vaults{" "}
              <span className="muted">
                (empty = no restriction; shift-click to select multiple)
              </span>
            </label>
            <br />
            {form.assignedVaults.length > 0 && (
              <span
                data-testid="new-user-vault-chips"
                style={{
                  display: "inline-flex",
                  flexWrap: "wrap",
                  gap: "0.25rem",
                  marginBottom: "0.25rem",
                }}
              >
                {form.assignedVaults.map((v) => (
                  <code key={v}>{v}</code>
                ))}
              </span>
            )}
            <br />
            <select
              id="new-user-vaults"
              multiple
              value={form.assignedVaults}
              onChange={(e) =>
                setForm({
                  ...form,
                  assignedVaults: Array.from(e.target.selectedOptions).map((o) => o.value),
                })
              }
              size={Math.min(Math.max(vaults.length, 3), 8)}
              style={{ minWidth: "12rem" }}
            >
              {vaults.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {vaults.length === 0 && (
              <span className="muted" style={{ marginLeft: "0.5rem" }}>
                No vaults registered on this hub yet.
              </span>
            )}
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
