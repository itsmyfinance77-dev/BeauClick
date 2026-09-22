'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { CATALOGUE_KEY_PATTERN } from '@beauclick/commercial-policy-contract';
import { Button, ErrorState, Input, LoadingState } from './ui';
import { ConfirmDialog, DataCell, DataRow, DataTable, EmptyState, Textarea } from './kit';
import { useAuth } from '@/lib/auth-context';
import {
  REASON_MAX,
  REASON_MIN,
  discardVersion,
  publishVersion,
  retireVersion,
  type LifecycleVersion,
  type VersionFamily,
} from '@/lib/commercial-admin-api';
import { DERIVED_LABEL, lifecycleView } from '@/lib/commercial-labels';
import { derivedState, parseWhole, refusalFrom, refusalMeansStale, type Refusal } from '@/lib/commercial-lifecycle';
import styles from './commercial-lifecycle.module.css';

/**
 * The version lifecycle shared by every admin commercial family (#239): the
 * plan and price catalogue, the collection policies, the outcome policies and
 * the customer policy copy. Each page supplies what is particular to its
 * family — its editor and its one-line summary of a version's terms — and this
 * file owns everything the families have in common, so the lifecycle rules are
 * written once:
 *
 * - `draft → published → retired`, one way. A draft can be edited, published
 *   or discarded; a published version can only be retired; a retired one can
 *   do nothing. A published row carries NO edit control — not a disabled one
 *   either — because a greyed-out Edit implies the action exists.
 * - Every mutation states a reason (3–500 characters), in the same dialog.
 * - A refusal keeps the dialog or the editor open with everything typed in it.
 *   A refusal that means the list is stale (somebody else moved first) also
 *   reloads the list underneath.
 * - The state is text AND shape, never colour alone.
 *
 * Built alongside `commission-policy-view.tsx` rather than on top of it; that
 * page can adopt these pieces later as a follow-up.
 */

// ================================================================== badges

export function LifecycleBadge({ state }: { state: string }) {
  const view = lifecycleView(state);
  return (
    <span className={`${styles.badge} ${styles[`state_${state}`] ?? ''}`} data-lifecycle={state}>
      <span aria-hidden="true">{view.glyph}</span> {view.label}
    </span>
  );
}

/** A published version's derived position. Says so: it is computed, not reported. */
export function DerivedBadge({ version }: { version: LifecycleVersion }) {
  const state = derivedState(version);
  if (!state) return null;
  const view = DERIVED_LABEL[state];
  return (
    <span className={`${styles.badge} ${styles[`derived_${state}`]}`} data-derived={state} title="برگرفته از بازهٔ فعال‌سازی">
      <span aria-hidden="true">{view.glyph}</span> {view.label}
    </span>
  );
}

const when = (iso: string | null) => (iso ? formatZonedDateTime(new Date(iso)) : null);

/**
 * The activation window in words. A draft of a family whose start the SERVER
 * sets has no start yet, and the text says who will set it rather than
 * leaving a blank that reads like a missing value.
 */
export function ActivationWindow({ version, startIsServer }: { version: LifecycleVersion; startIsServer: boolean }) {
  const start = when(version.activationStartsAt);
  const end = when(version.activationEndsAt);
  return (
    <span className={styles.window}>
      {start ? `از ${start}` : startIsServer ? 'شروع: لحظهٔ انتشار' : '—'}
      <br />
      {end ? `تا ${end}` : 'بدون پایان'}
    </span>
  );
}

// ================================================================== legend

/**
 * The lifecycle legend — spec 44 §2 and spec 47 §3.1.
 *
 * Stored states and derived states are two groups because they are two kinds
 * of fact: the first is a column in the database, the second is arithmetic on
 * a window. Rendering them as one list would invent a state PostgreSQL does
 * not recognise. `gates`, when given, is the third group — conditions that
 * belong to no version at all.
 */
export function LifecycleLegend({ gates }: { gates?: ReactNode }) {
  return (
    <section className={styles.legend} aria-label="راهنمای وضعیت‌ها" data-testid="lifecycle-legend">
      <div className={styles.legendGroup} data-legend-group="stored">
        <h3 className={styles.legendTitle}>وضعیت ذخیره‌شدهٔ هر نسخه</h3>
        <p className={styles.legendHint}>یک‌طرفه: پیش‌نویس ← منتشرشده ← بازنشسته. بازگشتی در کار نیست؛ برای تغییر، نسخهٔ تازه منتشر کنید.</p>
        <div className={styles.legendRow}>
          <LifecycleBadge state="draft" />
          <LifecycleBadge state="published" />
          <LifecycleBadge state="retired" />
        </div>
      </div>
      <div className={styles.legendGroup} data-legend-group="derived">
        <h3 className={styles.legendTitle}>وضعیت برگرفته از بازهٔ فعال‌سازی</h3>
        <p className={styles.legendHint}>ذخیره نمی‌شود؛ برای نسخهٔ منتشرشده از بازهٔ آن و ساعت همین مرورگر حساب می‌شود.</p>
        <div className={styles.legendRow}>
          {(Object.keys(DERIVED_LABEL) as (keyof typeof DERIVED_LABEL)[]).map((state) => (
            <span key={state} className={`${styles.badge} ${styles[`derived_${state}`]}`} data-derived={state}>
              <span aria-hidden="true">{DERIVED_LABEL[state].glyph}</span> {DERIVED_LABEL[state].label}
            </span>
          ))}
        </div>
      </div>
      {gates ? (
        <div className={styles.legendGroup} data-legend-group="gates">
          <h3 className={styles.legendTitle}>دروازه‌های بیرونی و عملیاتی — متعلق به هیچ نسخه‌ای</h3>
          {gates}
        </div>
      ) : null}
    </section>
  );
}

// ================================================================= refusal

/** The server's refusal: its own words, plus the structured parts it sent. */
export function RefusalNotice({ refusal }: { refusal: Refusal }) {
  return (
    <div role="alert" className={styles.refusal} data-refusal={refusal.code}>
      <p className={styles.refusalMessage}>{refusal.message}</p>
      {refusal.problems.length > 0 ? (
        <ul className={styles.problems} aria-label="مشکلات شرایط">
          {refusal.problems.map((problem) => (
            <li key={problem} dir="ltr">
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
      {refusal.detail ? (
        <p className={styles.refusalDetail} dir="ltr">
          {refusal.detail}
        </p>
      ) : null}
      {refusalMeansStale(refusal) ? <p className={styles.refusalHint}>فهرست نسخه‌ها تازه شد. آنچه نوشته‌اید سر جایش است.</p> : null}
    </div>
  );
}

// =========================================================== reason dialog

/** A confirmation whose confirm waits for a reason the server will accept. */
export function ReasonDialog({
  open,
  title,
  consequence,
  confirmLabel,
  tone = 'primary',
  busy,
  refusal,
  confirmBlocked,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy: boolean;
  refusal: Refusal | null;
  /** A reason the confirm stays disabled even with a reason — shown, never silent. */
  confirmBlocked?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const consequenceId = useId();
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const length = reason.trim().length;
  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      tone={tone}
      busy={busy}
      describedById={consequenceId}
      confirmDisabled={length < REASON_MIN || Boolean(confirmBlocked)}
      onCancel={onCancel}
      onConfirm={() => onConfirm(reason.trim())}
      body={
        <div className={styles.dialogBody}>
          <div id={consequenceId} className={styles.consequence}>
            {consequence}
          </div>
          {confirmBlocked ? <p className={styles.blocked}>{confirmBlocked}</p> : null}
          <Textarea
            label="دلیل"
            rows={2}
            maxLength={REASON_MAX}
            hint={`الزامی، ${toPersianDigits(REASON_MIN)} تا ${toPersianDigits(REASON_MAX)} نویسه. در گزارش عملیات ثبت می‌شود.`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
          {length > 0 && length < REASON_MIN ? (
            <p className={styles.fieldError}>دلیل باید دست‌کم {toPersianDigits(REASON_MIN)} نویسه باشد.</p>
          ) : null}
          {refusal ? <RefusalNotice refusal={refusal} /> : null}
        </div>
      }
    />
  );
}

// ============================================================ form pieces

/** The mandatory reason on an editor or a create form. */
export function ReasonField({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  const length = value.trim().length;
  return (
    <>
      <Textarea
        label="دلیل"
        rows={2}
        maxLength={REASON_MAX}
        hint={`الزامی، ${toPersianDigits(REASON_MIN)} تا ${toPersianDigits(REASON_MAX)} نویسه. در گزارش عملیات ثبت می‌شود.`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {length > 0 && length < REASON_MIN ? (
        <p className={styles.fieldError}>دلیل باید دست‌کم {toPersianDigits(REASON_MIN)} نویسه باشد.</p>
      ) : null}
    </>
  );
}

export const reasonIsValid = (reason: string) => reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;

/**
 * A whole-number field. `type="number" step="1"`, and the TEXT is kept as the
 * value so nothing is ever silently rounded; the caller parses it with
 * `parseWhole`. An empty field is empty — never a placeholder zero.
 */
export function WholeField({
  label,
  value,
  onChange,
  hint,
  min,
  max,
  disabled,
  unit,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  unit?: string;
}) {
  const shown = parseWhole(value);
  const invalid =
    value.trim() !== '' && (shown === null || (min !== undefined && shown < min) || (max !== undefined && shown > max));
  return (
    <div className={styles.whole}>
      <Input
        label={unit ? `${label} (${unit})` : label}
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        hint={hint}
        error={invalid ? `عدد صحیح${min !== undefined ? ` از ${toPersianDigits(min)}` : ''}${max !== undefined ? ` تا ${toPersianDigits(max)}` : ''} وارد کنید.` : null}
      />
      {/* Persian digits over the unchanged integer: only the glyphs differ. */}
      {shown !== null && !invalid ? <span className={styles.persianEcho}>{toPersianDigits(shown.toLocaleString('en-US'))}</span> : null}
    </div>
  );
}

/**
 * A SET of whole numbers — cutoffs, grace minutes, preset quantities. Members
 * are added one at a time and removed individually; the set is kept ascending
 * and duplicate-free, because that is the only shape the server accepts.
 */
export function NumberSetEditor({
  legend,
  unit,
  values,
  onChange,
  min,
  max,
  disabled,
  maxMembers,
}: {
  legend: string;
  unit: string;
  values: number[];
  onChange: (next: number[]) => void;
  min: number;
  max: number;
  disabled?: boolean;
  maxMembers: number;
}) {
  const [text, setText] = useState('');
  const parsed = parseWhole(text);
  const inRange = parsed !== null && parsed >= min && parsed <= max;
  const duplicate = parsed !== null && values.includes(parsed);
  const full = values.length >= maxMembers;
  const inputId = useId();

  function add() {
    if (!inRange || duplicate || full || parsed === null) return;
    onChange([...values, parsed].sort((a, b) => a - b));
    setText('');
  }

  return (
    <fieldset className={styles.set} data-set={legend}>
      <legend className={styles.setLegend}>{legend}</legend>
      {values.length === 0 ? <p className={styles.setEmpty}>هنوز عضوی ندارد.</p> : null}
      <ul className={styles.chips}>
        {values.map((value) => (
          <li key={value} className={styles.chip}>
            <span>
              {toPersianDigits(value)} {unit}
            </span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`حذف ${toPersianDigits(value)} ${unit}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
              disabled={disabled}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.setAdd}>
        <label htmlFor={inputId} className={styles.setAddLabel}>
          افزودن ({unit}، {toPersianDigits(min)} تا {toPersianDigits(max)})
        </label>
        <div className={styles.setAddRow}>
          <input
            id={inputId}
            className={styles.setInput}
            type="number"
            inputMode="numeric"
            step={1}
            min={min}
            max={max}
            dir="ltr"
            value={text}
            disabled={disabled || full}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="ghost" inline onClick={add} disabled={disabled || !inRange || duplicate || full}>
            افزودن
          </Button>
        </div>
        {text.trim() !== '' && !inRange ? <p className={styles.fieldError}>عدد صحیح در بازهٔ مجاز وارد کنید.</p> : null}
        {duplicate ? <p className={styles.fieldError}>این مقدار از پیش در مجموعه هست.</p> : null}
      </div>
    </fieldset>
  );
}

// ======================================================= version families

export interface FamilyKey {
  key: string;
  label: string | null;
  meta?: ReactNode;
}

export interface EditorProps<V> {
  /** The version being edited, or `null` for a new draft. Never pre-filled from anything else. */
  initial: V | null;
  busy: boolean;
  refusal: Refusal | null;
  onSubmit: (body: unknown) => void;
  onCancel: () => void;
}

export interface CreateKeyOptions {
  /** Whether the key also takes a display name. */
  displayName: boolean;
  /** An extra closed choice the key carries (a schedule's purpose). No default. */
  choice?: { legend: string; options: { value: string; label: string }[] };
  submit: (input: { key: string; displayName: string; choice: string | null; reason: string }) => Promise<unknown>;
}

type Pending = { kind: 'publish' | 'retire' | 'discard'; key: string; version: number };

const CONFIRM: Record<Pending['kind'], { title: string; label: string; tone: 'primary' | 'danger' }> = {
  publish: { title: 'انتشار این نسخه', label: 'انتشار', tone: 'primary' },
  retire: { title: 'بازنشستگی این نسخه', label: 'بازنشستگی', tone: 'primary' },
  discard: { title: 'دور انداختن این پیش‌نویس', label: 'دور انداختن', tone: 'danger' },
};

const DISCARD_CONSEQUENCE = 'این پیش‌نویس حذف می‌شود. هیچ نسخهٔ منتشرشده‌ای تحت تأثیر قرار نمی‌گیرد.';

/**
 * One versioned family: its keys, each key's versions, and every lifecycle
 * action on them. See the file docblock for the rules it holds.
 */
export function VersionFamilySection<V extends LifecycleVersion>({
  id,
  title,
  intro,
  family,
  emptyMessage,
  loadKeys,
  loadVersions,
  loadEditable,
  create,
  summarize,
  renderEditor,
  draft,
  replace,
  newDraftBlocked,
  startIsServer,
  publishConsequence,
  retireConsequence,
  onVersions,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  family: VersionFamily;
  emptyMessage: string;
  loadKeys: () => Promise<FamilyKey[]>;
  loadVersions: (key: string) => Promise<V[]>;
  /** For families whose list omits terms the editor needs (tiers, a copy's text). */
  loadEditable?: (key: string, version: number) => Promise<V>;
  create: CreateKeyOptions;
  summarize: (version: V) => ReactNode;
  renderEditor: (props: EditorProps<V>) => ReactNode;
  draft: ((key: string, body: unknown) => Promise<unknown>) | null;
  replace: (key: string, version: number, body: unknown) => Promise<unknown>;
  /** Set when a NEW draft cannot be made from this UI; the text says why. Editing existing drafts is unaffected. */
  newDraftBlocked?: ReactNode;
  startIsServer: boolean;
  publishConsequence: ReactNode;
  retireConsequence: ReactNode;
  /** Every load of a key's versions, for a page that derives something across keys. */
  onVersions?: (key: string, versions: V[]) => void;
}) {
  const { api } = useAuth();
  const [keys, setKeys] = useState<FamilyKey[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, V[]>>({});
  const [versionErrors, setVersionErrors] = useState<Record<string, string>>({});

  const [editing, setEditing] = useState<{ key: string; initial: V | null } | null>(null);
  const [editLoading, setEditLoading] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingId = useId();
  const onVersionsRef = useRef(onVersions);
  onVersionsRef.current = onVersions;

  const reloadVersions = useCallback(
    async (key: string) => {
      setVersionErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        const rows = await loadVersions(key);
        setVersions((prev) => ({ ...prev, [key]: rows }));
        onVersionsRef.current?.(key, rows);
      } catch (err) {
        setVersionErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : 'نسخه‌ها بارگذاری نشد.' }));
      }
    },
    [loadVersions],
  );

  const reloadKeys = useCallback(async () => {
    setKeysError(null);
    try {
      const rows = await loadKeys();
      setKeys(rows);
      await Promise.all(rows.map((row) => reloadVersions(row.key)));
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : 'فهرست بارگذاری نشد.');
    }
  }, [loadKeys, reloadVersions]);

  useEffect(() => {
    void reloadKeys();
  }, [reloadKeys]);

  /** Every mutation goes through here. A refusal closes nothing. */
  async function run(action: () => Promise<unknown>, key: string | null, success: string): Promise<boolean> {
    setBusy(true);
    setRefusal(null);
    try {
      await action();
      if (key) await reloadVersions(key);
      else await reloadKeys();
      setAnnouncement(success);
      return true;
    } catch (err) {
      const next = refusalFrom(err);
      setRefusal(next);
      if (key && refusalMeansStale(next)) await reloadVersions(key);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(key: string, version: V | null) {
    setRefusal(null);
    setCreating(false);
    if (version && loadEditable) {
      setEditLoading(`${key}:${version.version}`);
      try {
        setEditing({ key, initial: await loadEditable(key, version.version) });
      } catch (err) {
        setRefusal(refusalFrom(err, 'این نسخه برای ویرایش بارگذاری نشد.'));
      } finally {
        setEditLoading(null);
      }
      return;
    }
    setEditing({ key, initial: version });
  }

  async function confirm(reason: string) {
    if (!pending) return;
    const { kind, key, version } = pending;
    const ok = await run(
      () =>
        kind === 'publish'
          ? publishVersion(api, family, key, version, reason)
          : kind === 'retire'
            ? retireVersion(api, family, key, version, reason)
            : discardVersion(api, family, key, version, reason),
      key,
      kind === 'publish' ? `نسخهٔ ${toPersianDigits(version)} منتشر شد.` : kind === 'retire' ? `نسخهٔ ${toPersianDigits(version)} بازنشسته شد.` : 'پیش‌نویس دور انداخته شد.',
    );
    if (ok) setPending(null);
  }

  function actionsFor(key: string, version: V) {
    const n = toPersianDigits(version.version);
    if (version.lifecycleState === 'published') {
      return (
        <Button
          type="button"
          variant="ghost"
          inline
          aria-label={`بازنشستگی نسخهٔ ${n}`}
          onClick={() => {
            setRefusal(null);
            setPending({ kind: 'retire', key, version: version.version });
          }}
        >
          بازنشستگی
        </Button>
      );
    }
    // Retired — or any state this client does not know — carries nothing.
    if (version.lifecycleState !== 'draft') return null;
    return (
      <div className={styles.rowActions}>
        <Button
          type="button"
          inline
          aria-label={`ویرایش پیش‌نویس ${n}`}
          loading={editLoading === `${key}:${version.version}`}
          onClick={() => void openEditor(key, version)}
        >
          ویرایش
        </Button>
        <Button
          type="button"
          variant="ghost"
          inline
          aria-label={`انتشار نسخهٔ ${n}`}
          onClick={() => {
            setRefusal(null);
            setPending({ kind: 'publish', key, version: version.version });
          }}
        >
          انتشار
        </Button>
        <Button
          type="button"
          variant="ghost"
          inline
          aria-label={`دور انداختن پیش‌نویس ${n}`}
          onClick={() => {
            setRefusal(null);
            setPending({ kind: 'discard', key, version: version.version });
          }}
        >
          دور انداختن
        </Button>
      </div>
    );
  }

  return (
    <section className={styles.family} aria-labelledby={headingId} data-family={id}>
      <div className={styles.familyHead}>
        <h2 id={headingId} className={styles.familyTitle}>
          {title}
        </h2>
        {!creating ? (
          <Button
            type="button"
            variant="ghost"
            inline
            onClick={() => {
              setCreating(true);
              setEditing(null);
              setRefusal(null);
            }}
          >
            شناسهٔ تازه
          </Button>
        ) : null}
      </div>
      {intro ? <div className={styles.familyIntro}>{intro}</div> : null}
      <p className={styles.live} aria-live="polite">
        {announcement}
      </p>

      {creating ? (
        <CreateKeyForm
          options={create}
          busy={busy}
          refusal={refusal}
          onCancel={() => {
            setCreating(false);
            setRefusal(null);
          }}
          onSubmit={async (input) => {
            const ok = await run(() => create.submit(input), null, `«${input.key}» ساخته شد.`);
            if (ok) setCreating(false);
          }}
        />
      ) : null}

      {keysError ? (
        <ErrorState message={keysError} onRetry={() => void reloadKeys()} />
      ) : keys === null ? (
        <LoadingState label="در حال بارگذاری…" lines={3} />
      ) : keys.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        keys.map((row) => {
          const rows = versions[row.key];
          return (
            <article key={row.key} className={styles.keyCard} data-key={row.key}>
              <header className={styles.keyHead}>
                <div className={styles.keyName}>
                  <span className={styles.keyId} dir="ltr">
                    {row.key}
                  </span>
                  {row.label ? <span className={styles.keyLabel}>{row.label}</span> : null}
                  {row.meta ? <span className={styles.keyMeta}>{row.meta}</span> : null}
                </div>
                {newDraftBlocked ? null : draft ? (
                  <Button type="button" inline onClick={() => void openEditor(row.key, null)} aria-label={`پیش‌نویس تازه برای ${row.key}`}>
                    پیش‌نویس تازه
                  </Button>
                ) : null}
              </header>
              {newDraftBlocked ? (
                <p className={styles.blocked} role="note">
                  {newDraftBlocked}
                </p>
              ) : null}

              {versionErrors[row.key] ? (
                <ErrorState message={versionErrors[row.key]} onRetry={() => void reloadVersions(row.key)} />
              ) : rows === undefined ? (
                <LoadingState label="در حال بارگذاری نسخه‌ها…" lines={2} />
              ) : rows.length === 0 ? (
                <p className={styles.noVersions}>هنوز نسخه‌ای ندارد.</p>
              ) : (
                <DataTable head={['نسخه', 'وضعیت', 'بازهٔ فعال‌سازی', 'شرایط', 'کنش']} aria-labelledby={headingId}>
                  {rows.map((version) => (
                    <DataRow key={version.version} data-version={version.version} data-state={version.lifecycleState}>
                      <DataCell label="نسخه">{toPersianDigits(version.version)}</DataCell>
                      <DataCell label="وضعیت">
                        <span className={styles.badges}>
                          <LifecycleBadge state={version.lifecycleState} />
                          <DerivedBadge version={version} />
                        </span>
                      </DataCell>
                      <DataCell label="بازهٔ فعال‌سازی">
                        <ActivationWindow version={version} startIsServer={startIsServer} />
                      </DataCell>
                      <DataCell label="شرایط">{summarize(version)}</DataCell>
                      <DataCell label="کنش">{actionsFor(row.key, version) ?? <span className={styles.noAction}>—</span>}</DataCell>
                    </DataRow>
                  ))}
                </DataTable>
              )}

              {editing?.key === row.key ? (
                <div className={styles.editor} data-editor={row.key}>
                  <h3 className={styles.editorTitle}>
                    {editing.initial ? `ویرایش پیش‌نویس ${toPersianDigits(editing.initial.version)}` : 'پیش‌نویس تازه'}
                  </h3>
                  {renderEditor({
                    initial: editing.initial,
                    busy,
                    refusal,
                    onCancel: () => {
                      setEditing(null);
                      setRefusal(null);
                    },
                    onSubmit: (body) =>
                      void (async () => {
                        const initial = editing.initial;
                        const ok = await run(
                          () => (initial ? replace(row.key, initial.version, body) : draft!(row.key, body)),
                          row.key,
                          initial ? 'پیش‌نویس ذخیره شد.' : 'پیش‌نویس ثبت شد.',
                        );
                        if (ok) setEditing(null);
                      })(),
                  })}
                </div>
              ) : null}
            </article>
          );
        })
      )}

      {!editing && !creating && !pending && refusal ? <RefusalNotice refusal={refusal} /> : null}

      <ReasonDialog
        open={pending !== null}
        title={pending ? CONFIRM[pending.kind].title : ''}
        confirmLabel={pending ? CONFIRM[pending.kind].label : ''}
        tone={pending ? CONFIRM[pending.kind].tone : 'primary'}
        busy={busy}
        refusal={pending ? refusal : null}
        consequence={
          pending?.kind === 'publish' ? publishConsequence : pending?.kind === 'retire' ? retireConsequence : DISCARD_CONSEQUENCE
        }
        onCancel={() => {
          setPending(null);
          setRefusal(null);
        }}
        onConfirm={(reason) => void confirm(reason)}
      />
    </section>
  );
}

/** A new key: the key itself (the server's `CATALOGUE_KEY_PATTERN`), an optional display name, an optional closed choice, a reason. */
function CreateKeyForm({
  options,
  busy,
  refusal,
  onSubmit,
  onCancel,
}: {
  options: CreateKeyOptions;
  busy: boolean;
  refusal: Refusal | null;
  onSubmit: (input: { key: string; displayName: string; choice: string | null; reason: string }) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const choiceName = useId();

  const keyValid = CATALOGUE_KEY_PATTERN.test(key);
  const nameValid = !options.displayName || (displayName.trim().length >= 1 && displayName.trim().length <= 120);
  const choiceValid = !options.choice || choice !== null;
  const ready = keyValid && nameValid && choiceValid && reasonIsValid(reason);

  return (
    <form
      className={styles.createForm}
      data-testid="create-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit({ key, displayName: displayName.trim(), choice, reason: reason.trim() });
      }}
    >
      <Input
        label="شناسه"
        dir="ltr"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        disabled={busy}
        hint="با یک حرف لاتین شروع شود؛ فقط حرف، رقم، خط تیره و زیرخط؛ حداکثر ۶۴ نویسه. پس از ساخت تغییر نمی‌کند."
        error={key !== '' && !keyValid ? 'این شناسه قالب مجاز را ندارد.' : null}
      />
      {options.displayName ? (
        <Input label="نام نمایشی" value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
      ) : null}
      {options.choice ? (
        <fieldset className={styles.radioGroup}>
          <legend className={styles.setLegend}>{options.choice.legend}</legend>
          {options.choice.options.map((option) => (
            <label key={option.value} className={styles.radio}>
              <input
                type="radio"
                name={choiceName}
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
                disabled={busy}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <ReasonField value={reason} onChange={setReason} disabled={busy} />
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <div className={styles.formActions}>
        <Button type="submit" inline disabled={!ready || busy} loading={busy}>
          ساختن
        </Button>
        <Button type="button" variant="ghost" inline onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </form>
  );
}
