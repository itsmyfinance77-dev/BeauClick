'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, PageHeader, Textarea, type BadgeTone } from '@/components/kit';
import { TIMELINE_KIND_LABEL, timelineKind, timelineLabel } from '@/lib/journey-timeline';
import {
  createJourneyGoal,
  journeyGoals,
  journeyProfile,
  journeyTimeline,
  updateGoalStatus,
  updateJourneyProfile,
  type BeautyGoal,
  type BeautyProfile,
  type TimelineEntry,
} from '@/lib/phase3-api';
import styles from './journey.module.css';

const GOAL_STATUS: Record<BeautyGoal['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'در حال پیگیری', tone: 'primary' },
  achieved: { label: 'محقق شد', tone: 'success' },
  abandoned: { label: 'رها شد', tone: 'neutral' },
};

export default function JourneyPage() {
  return (
    <ProtectedRoute>
      <Journey />
    </ProtectedRoute>
  );
}

function Journey() {
  const { api } = useAuth();
  // The profile is fetched and stored so the form reflects the SERVER's copy
  // after every write, not the optimistic local one. Nothing renders it
  // directly -- `notes` and `budget` below are seeded from it.
  const [, setProfile] = useState<BeautyProfile | null>(null);
  const [goals, setGoals] = useState<BeautyGoal[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  // The timeline is paginated by the server; only the first page used to be
  // reachable. `timelinePage` is the last page fetched.
  const [timelinePage, setTimelinePage] = useState(1);
  const [timelinePages, setTimelinePages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notes, setNotes] = useState('');
  const [budget, setBudget] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [loading, setLoading] = useState(true);
  // Not cosmetic here. On a failed load `notes`/`budget` keep their empty
  // initial values, so rendering the profile editor anyway would show the
  // user a blank form over data that still exists -- and submitting it sends
  // notes: null, budgetMaxToman: null, destroying the real profile. The
  // editor is not shown at all until a load has actually succeeded.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, g, t] = await Promise.all([journeyProfile(api), journeyGoals(api), journeyTimeline(api)]);
      setProfile(p.data);
      setNotes(p.data?.notes ?? '');
      setBudget(p.data?.budgetMaxToman ? String(p.data.budgetMaxToman) : '');
      setGoals(g.data ?? []);
      setTimeline(t.data?.items ?? []);
      setTimelinePage(1);
      setTimelinePages(t.data?.pagination?.totalPages ?? 1);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'مسیر زیبایی بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await updateJourneyProfile(api, {
        notes: notes.trim() === '' ? null : notes,
        budgetMaxToman: budget.trim() === '' ? null : Number(budget),
      });
      setProfile(res.data);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ذخیره نشد.');
    } finally {
      setSaving(false);
    }
  };

  const addGoal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newGoal.trim()) return;
    setError(null);
    try {
      await createJourneyGoal(api, { title: newGoal.trim() });
      setNewGoal('');
      const g = await journeyGoals(api);
      setGoals(g.data ?? []);
      // A new goal writes a timeline entry in the same transaction, so the
      // timeline is refetched rather than left stale.
      const t = await journeyTimeline(api);
      setTimeline(t.data?.items ?? []);
      setTimelinePage(1);
      setTimelinePages(t.data?.pagination?.totalPages ?? 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'هدف ثبت نشد.');
    }
  };

  const achieve = async (goal: BeautyGoal) => {
    try {
      await updateGoalStatus(api, goal.id, 'achieved');
      setGoals((current) => current.map((g) => (g.id === goal.id ? { ...g, status: 'achieved' } : g)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'وضعیت هدف تغییر نکرد.');
    }
  };

  const loadMore = async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const next = timelinePage + 1;
      const t = await journeyTimeline(api, next);
      // Appended, keyed by the entry itself, so a page that overlaps the last
      // one (an entry written between the two requests) cannot duplicate a row.
      setTimeline((current) => {
        const seen = new Set(current.map((e) => `${e.type}-${e.sourceId}`));
        return [...current, ...(t.data?.items ?? []).filter((e) => !seen.has(`${e.type}-${e.sourceId}`))];
      });
      setTimelinePage(next);
      setTimelinePages(t.data?.pagination?.totalPages ?? next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'بارگذاری بیشتر انجام نشد.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <LoadingState label="در حال بارگذاری…" lines={5} />;
  if (!loaded) return <ErrorState message={error ?? 'مسیر زیبایی بارگذاری نشد.'} onRetry={() => void load()} />;

  return (
    <section>
      <PageHeader title="مسیر زیبایی من" subtitle="ترجیح‌ها و اهداف شما، فقط برای خودتان." />

      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">ذخیره شد.</Alert>}

      <div className={styles.columns}>
        <div className={styles.stack}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>ترجیح‌های من</h2>
            <form onSubmit={saveProfile}>
              <Input
                label="حداکثر بودجه (تومان)"
                type="text"
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                hint="می‌توانید عدد را با ارقام فارسی هم بنویسید."
              />

              <Textarea
                id="journey-notes"
                label="یادداشت‌های شخصی"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
                rows={4}
                // Stated to the customer, because it is a real and deliberate
                // guarantee (ADR-019) rather than an implementation detail:
                // these notes never enter the AI assistant's context.
                hint={`این یادداشت‌ها خصوصی است و هرگز به دستیار هوشمند ارسال نمی‌شود. ${toPersianDigits(notes.length)} از ${toPersianDigits(500)}`}
              />

              <Button type="submit" loading={saving}>
                ذخیره
              </Button>
            </form>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>اهداف من</h2>
            <form onSubmit={addGoal} className={styles.addGoal}>
              <div className={styles.addGoalField}>
                <label htmlFor="new-goal" className={styles.fieldLabel}>
                  هدف تازه
                </label>
                <input
                  id="new-goal"
                  className={styles.textInput}
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                  maxLength={191}
                  placeholder="مثلاً آماده شدن برای عروسی"
                />
              </div>
              <Button type="submit" inline>
                افزودن
              </Button>
            </form>

            {goals.length === 0 ? (
              <p className={styles.empty}>هنوز هدفی ثبت نکرده‌اید.</p>
            ) : (
              <ul className={styles.goals}>
                {goals.map((goal) => {
                  const status = GOAL_STATUS[goal.status];
                  return (
                    <li key={goal.id} className={styles.goal} data-goal={goal.id}>
                      <div className={styles.goalText}>
                        <span className={`${styles.goalTitle} ${goal.status === 'achieved' ? styles.goalDone : ''}`}>
                          {goal.title}
                        </span>
                        {goal.targetDate ? (
                          <span className={styles.goalDate}>
                            تا {formatFullJalaliDate(new Date(goal.targetDate))}
                          </span>
                        ) : null}
                      </div>
                      {goal.status === 'active' ? (
                        <button type="button" className={styles.control} onClick={() => void achieve(goal)}>
                          محقق شد
                        </button>
                      ) : (
                        <Badge tone={status.tone}>{status.label}</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>تاریخچه</h2>
          {timeline.length === 0 ? (
            <p className={styles.empty}>هنوز رویدادی ثبت نشده است.</p>
          ) : (
            <>
              <ol className={styles.timeline} aria-label="تاریخچهٔ فعالیت‌ها">
                {timeline.map((entry) => {
                  const kind = timelineKind(entry.type);
                  return (
                    <li key={`${entry.type}-${entry.sourceId}`} className={styles.entry}>
                      <span className={styles.marker} aria-hidden="true" />
                      <div className={styles.entryHead}>
                        {/* The kind is spoken, not implied by a marker: "رزرو: رزرو ثبت شد". */}
                        {kind ? <Badge tone="neutral">{TIMELINE_KIND_LABEL[kind]}</Badge> : null}
                        <span className={styles.entryLabel}>{timelineLabel(entry)}</span>
                      </div>
                      <span className={styles.entryDate}>{formatFullJalaliDate(new Date(entry.occurredAt))}</span>
                    </li>
                  );
                })}
              </ol>
              {timelinePage < timelinePages ? (
                <div className={styles.more}>
                  <Button variant="ghost" inline onClick={() => void loadMore()} loading={loadingMore}>
                    نمایش بیشتر
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
