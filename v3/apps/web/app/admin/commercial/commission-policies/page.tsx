'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/ui';
import { PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { COMPONENTS, ComponentCard, VersionTimeline } from '@/components/commission-policy-view';
import {
  commissionPolicies,
  commissionPolicyVersions,
  type CommissionComponent,
  type CommissionPolicySummary,
  type CommissionPolicyVersion,
} from '@/lib/admin-api';

/**
 * What the platform charges -- V3.3 `#43b-1` / #173, ADR-052 §1.
 *
 * ## The read half only
 *
 * Story #205 builds what an administrator can SEE; #173's editor, publish and
 * retire dialogs are their own story. Nothing here mutates, and there is no
 * disabled write control standing in for the missing half -- a button that
 * does nothing is worse than no button, because it implies the action exists
 * and is merely unavailable to you.
 *
 * ## The first commercial admin surface
 *
 * `apps/web` had no `/admin/commercial` route group and `admin-api.ts` had no
 * commercial namespace before this. Screen 40, which this screen's spec says
 * to be consistent with, does not exist in code either -- so the patterns here
 * (route group, capability-gated nav entry, lifecycle by text and shape) are
 * established rather than followed.
 *
 * This file owns the reads and their failures; `commission-policy-view.tsx`
 * owns what each state looks like.
 */

export default function AdminCommissionPoliciesPage() {
  const { api } = useAuth();

  const [policies, setPolicies] = useState<CommissionPolicySummary[] | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [policiesLoading, setPoliciesLoading] = useState(true);

  // Keyed by `policyKey`, because each policy's versions are their own read
  // and their own failure — one component's timeline failing must not blank
  // the other two.
  const [versions, setVersions] = useState<Record<string, CommissionPolicyVersion[]>>({});
  const [versionErrors, setVersionErrors] = useState<Record<string, string>>({});
  const [versionsLoading, setVersionsLoading] = useState<Record<string, boolean>>({});

  const loadVersions = useCallback(
    async (policyKey: string) => {
      setVersionsLoading((prev) => ({ ...prev, [policyKey]: true }));
      setVersionErrors((prev) => {
        const next = { ...prev };
        delete next[policyKey];
        return next;
      });
      try {
        const res = await commissionPolicyVersions(api, policyKey);
        setVersions((prev) => ({ ...prev, [policyKey]: res.data?.items ?? [] }));
      } catch (err) {
        setVersionErrors((prev) => ({
          ...prev,
          [policyKey]: err instanceof Error ? err.message : 'نسخه‌های این سیاست بارگذاری نشد.',
        }));
      } finally {
        setVersionsLoading((prev) => ({ ...prev, [policyKey]: false }));
      }
    },
    [api],
  );

  const loadPolicies = useCallback(async () => {
    setPoliciesLoading(true);
    setPoliciesError(null);
    try {
      const res = await commissionPolicies(api);
      const items = res.data?.items ?? [];
      setPolicies(items);
      await Promise.all(items.map((policy) => loadVersions(policy.policyKey)));
    } catch (err) {
      setPoliciesError(err instanceof Error ? err.message : 'سیاست‌های کمیسیون بارگذاری نشد.');
    } finally {
      setPoliciesLoading(false);
    }
  }, [api, loadVersions]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const policyFor = (component: CommissionComponent) => policies?.find((p) => p.component === component);

  return (
    <div>
      <PageHeader
        title="سیاست کمیسیون"
        subtitle="آنچه سکو دریافت می‌کند. هیچ نرخی در کد نیست — هر رقمی که اینجا دیده می‌شود را یک مدیر منتشر کرده است."
      />

      {policiesError ? (
        <ErrorState message={policiesError} onRetry={() => void loadPolicies()} />
      ) : policiesLoading || policies === null ? (
        <LoadingState label="در حال بارگذاری سیاست‌ها…" />
      ) : (
        <>
          <div
            data-testid="commission-components"
            style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
          >
            {COMPONENTS.map((component) => {
              const policy = policyFor(component);
              return (
                <ComponentCard
                  key={component}
                  component={component}
                  policy={policy}
                  versions={policy ? versions[policy.policyKey] : undefined}
                  versionsError={policy ? versionErrors[policy.policyKey] : undefined}
                  versionsLoading={policy ? !!versionsLoading[policy.policyKey] : false}
                  onRetry={(policyKey) => void loadVersions(policyKey)}
                />
              );
            })}
          </div>

          {COMPONENTS.map((component) => {
            const policy = policyFor(component);
            const rows = policy ? versions[policy.policyKey] : undefined;
            if (!policy || !rows || rows.length === 0) return null;
            return <VersionTimeline key={component} policy={policy} versions={rows} />;
          })}
        </>
      )}
    </div>
  );
}
