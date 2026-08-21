'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, Input, LoadingState } from '@/components/ui';
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

export default function JourneyPage() {
  return (
    <ProtectedRoute>
      <Journey />
    </ProtectedRoute>
  );
}

function Journey() {
  const { api } = useAuth();
  const [profile, setProfile] = useState<BeautyProfile | null>(null);
  const [goals, setGoals] = useState<BeautyGoal[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [notes, setNotes] = useState('');
  const [budget, setBudget] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [loading, setLoading] = useState(true);
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

  if (loading) return <LoadingState label="در حال بارگذاری…" />;

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 4 }}>مسیر زیبایی من</h1>
      <p style={{ color: 'var(--bc-color-ink-faint)', fontSize: 14, marginBlockEnd: 20 }}>
        ترجیح‌ها و اهداف شما، فقط برای خودتان.
      </p>

      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">ذخیره شد.</Alert>}

      <Card>
        <h2 style={{ fontSize: 18, marginBlockStart: 0 }}>ترجیح‌های من</h2>
        <form onSubmit={saveProfile}>
          <Input
            label="حداکثر بودجه (تومان)"
            type="text"
            inputMode="numeric"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            hint="می‌توانید عدد را با ارقام فارسی هم بنویسید."
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 16 }}>
            <label htmlFor="journey-notes" style={{ fontWeight: 600, fontSize: 14 }}>
              یادداشت‌های شخصی
            </label>
            <textarea
              id="journey-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={4}
              aria-describedby="journey-notes-hint"
              style={{
                font: 'inherit',
                padding: '12px 14px',
                borderRadius: 'var(--bc-radius-input)',
                border: '1px solid var(--bc-color-line)',
                background: 'var(--bc-color-surface)',
                color: 'var(--bc-color-ink)',
                resize: 'vertical',
              }}
            />
            <p id="journey-notes-hint" style={{ margin: 0, fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
              {/* Stated to the customer, because it is a real and deliberate
                  guarantee (ADR-019) rather than an implementation detail:
                  these notes never enter the AI assistant's context. */}
              این یادداشت‌ها خصوصی است و هرگز به دستیار هوشمند ارسال نمی‌شود.{' '}
              {toPersianDigits(notes.length)} از {toPersianDigits(500)}
            </p>
          </div>

          <Button type="submit" loading={saving}>
            ذخیره
          </Button>
        </form>
      </Card>

      <Card>
        <h2 style={{ fontSize: 18, marginBlockStart: 0 }}>اهداف من</h2>
        <form onSubmit={addGoal} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockEnd: 16 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <label htmlFor="new-goal" style={{ display: 'block', fontWeight: 600, fontSize: 14, marginBlockEnd: 6 }}>
              هدف تازه
            </label>
            <input
              id="new-goal"
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
              maxLength={191}
              placeholder="مثلاً آماده شدن برای عروسی"
              style={{
                width: '100%',
                font: 'inherit',
                padding: '12px 14px',
                minHeight: 44,
                borderRadius: 'var(--bc-radius-input)',
                border: '1px solid var(--bc-color-line)',
                background: 'var(--bc-color-surface)',
                color: 'var(--bc-color-ink)',
              }}
            />
          </div>
          <div style={{ alignSelf: 'flex-end', minWidth: 120 }}>
            <Button type="submit">افزودن</Button>
          </div>
        </form>

        {goals.length === 0 ? (
          <p style={{ margin: 0, fontSize: 14, color: 'var(--bc-color-ink-faint)' }}>هنوز هدفی ثبت نکرده‌اید.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {goals.map((goal) => (
              <li
                key={goal.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  padding: '10px 0',
                  borderBlockEnd: '1px solid var(--bc-color-line)',
                }}
              >
                <span style={{ fontSize: 15, textDecoration: goal.status === 'achieved' ? 'line-through' : 'none' }}>
                  {goal.title}
                </span>
                {goal.status === 'active' ? (
                  <button
                    type="button"
                    onClick={() => void achieve(goal)}
                    style={{
                      font: 'inherit',
                      fontSize: 14,
                      padding: '10px 14px',
                      minHeight: 44,
                      borderRadius: 'var(--bc-radius-button)',
                      border: '1px solid var(--bc-color-line)',
                      background: 'transparent',
                      color: 'var(--bc-color-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    محقق شد
                  </button>
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>محقق شد</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h2 style={{ fontSize: 18, marginBlockStart: 24 }}>تاریخچه</h2>
      {timeline.length === 0 ? (
        <Card>
          <p style={{ margin: 0 }}>هنوز رویدادی ثبت نشده است.</p>
        </Card>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {timeline.map((entry) => (
            <li key={`${entry.type}-${entry.sourceId}`}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15 }}>{entry.label}</span>
                  <span style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    {formatFullJalaliDate(new Date(entry.occurredAt))}
                  </span>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
