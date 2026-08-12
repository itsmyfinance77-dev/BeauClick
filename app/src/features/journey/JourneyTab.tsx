import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Card, LoadingDots, EmptyState } from '@/design-system';
import { formatToman, formatShortDate, toPersianDigits } from '@/lib/format';
import { RecommendationCard } from '@/features/ai/RecommendationCard';
import { GoalForm } from './GoalForm';
import type { BeautyGoal, JourneySummary, TimelineEntry } from './types';

const STATUS_LABELS: Record<string, string> = {
	active: 'در حال پیگیری',
	achieved: 'محقق‌شده',
	abandoned: 'کنار گذاشته‌شده',
};

function fmtDate( iso: string ): string {
	try {
		return formatShortDate( new Date( iso.replace( ' ', 'T' ) ) ).weekday;
	} catch {
		return iso;
	}
}

export function JourneyTab() {
	const [ summary, setSummary ] = useState<JourneySummary | null>( null );
	const [ goals, setGoals ] = useState<BeautyGoal[] | null>( null );
	const [ timeline, setTimeline ] = useState<TimelineEntry[] | null>( null );
	const [ specialties, setSpecialties ] = useState<{ id: number; name: string }[]>( [] );
	const [ error, setError ] = useState<string | null>( null );
	const [ showGoalForm, setShowGoalForm ] = useState( false );

	function loadAll() {
		api.get<JourneySummary>( '/journey/summary' ).then( setSummary ).catch( () => setError( 'خطا در دریافت مسیر زیبایی.' ) );
		api.get<BeautyGoal[]>( '/journey/goals' ).then( setGoals ).catch( () => {} );
		api.get<TimelineEntry[]>( '/journey/timeline?per_page=15' ).then( setTimeline ).catch( () => {} );
		api.get<{ id: number; name: string }[]>( '/marketplace/specialties' ).then( setSpecialties ).catch( () => {} );
	}

	useEffect( loadAll, [] );

	async function markGoal( id: number, status: 'achieved' | 'abandoned' ) {
		try {
			await api.patch( `/journey/goals/${ id }`, { status } );
			loadAll();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'به‌روزرسانی هدف ناموفق بود.' );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! summary || ! goals ) return <LoadingDots />;

	const hasAnyContent = goals.length > 0 || summary.upcomingBookings.length > 0 || summary.recentCompletedServices.length > 0;

	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 28 } }>
			<div>
				<h1 style={ { fontSize: 22, marginTop: 0, marginBottom: 4 } }>مسیر زیبایی من</h1>
				<p style={ { margin: 0, fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>
					{ summary.memberSince && `عضو از ${ fmtDate( summary.memberSince ) } · ` }
					{ null != summary.loyaltyBalance && `${ toPersianDigits( summary.loyaltyBalance ) } امتیاز وفاداری` }
				</p>
			</div>

			{ ! hasAnyContent && (
				<EmptyState title="مسیر زیبایی‌ات هنوز خالیه — یه هدف تعریف کن تا شروع کنیم." />
			) }

			<section>
				<div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } }>
					<h2 style={ { fontSize: 16, margin: 0 } }>اهداف من</h2>
					{ ! showGoalForm && <Button variant="outline" onClick={ () => setShowGoalForm( true ) }>+ هدف جدید</Button> }
				</div>

				{ showGoalForm && (
					<div style={ { marginBottom: 12 } }>
						<GoalForm
							specialties={ specialties }
							onCreated={ () => { setShowGoalForm( false ); loadAll(); } }
							onCancel={ () => setShowGoalForm( false ) }
						/>
					</div>
				) }

				{ goals.length === 0 && ! showGoalForm && (
					<EmptyState title="هنوز هدفی ثبت نکرده‌ای." />
				) }

				<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
					{ goals.map( ( g ) => (
						<Card key={ g.id } style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }>
							<div>
								<strong>{ g.title }</strong>
								<p style={ { margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
									{ STATUS_LABELS[ g.status ] ?? g.status }
									{ null != g.budget && ` · بودجه ${ formatToman( g.budget ) } تومان` }
									{ g.targetDate && ` · تا ${ toPersianDigits( g.targetDate ) }` }
								</p>
							</div>
							{ 'active' === g.status && (
								<div style={ { display: 'flex', gap: 6 } }>
									<Button variant="outline" onClick={ () => markGoal( g.id, 'achieved' ) }>محقق شد</Button>
									<Button variant="outline" onClick={ () => markGoal( g.id, 'abandoned' ) }>کنار گذاشتن</Button>
								</div>
							) }
						</Card>
					) ) }
				</div>
			</section>

			{ summary.upcomingBookings.length > 0 && (
				<section>
					<h2 style={ { fontSize: 16, marginBottom: 10 } }>نوبت‌های آینده</h2>
					<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
						{ summary.upcomingBookings.map( ( b ) => (
							<a key={ b.id } href={ `/professional/${ b.providerId }` } className="bc-card" style={ { padding: 14, display: 'block', textDecoration: 'none', color: 'inherit' } }>
								<strong>{ b.providerName }</strong>
								{ b.serviceName && <span style={ { color: 'var(--bc-color-ink-faint)' } }> · { b.serviceName }</span> }
								<p style={ { margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">{ fmtDate( b.slotStart ) }</p>
							</a>
						) ) }
					</div>
				</section>
			) }

			{ summary.recentCompletedServices.length > 0 && (
				<section>
					<h2 style={ { fontSize: 16, marginBottom: 10 } }>خدمات انجام‌شده</h2>
					<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
						{ summary.recentCompletedServices.map( ( b ) => (
							<div key={ b.id } className="bc-card" style={ { padding: 14 } }>
								<strong>{ b.providerName }</strong>
								{ b.serviceName && <span style={ { color: 'var(--bc-color-ink-faint)' } }> · { b.serviceName }</span> }
								<p style={ { margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">{ fmtDate( b.slotStart ) }</p>
							</div>
						) ) }
					</div>
				</section>
			) }

			{ summary.recentRecommendations.length > 0 && (
				<section>
					<h2 style={ { fontSize: 16, marginBottom: 10 } }>پیشنهادهای شخصی</h2>
					<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
						{ summary.recentRecommendations.map( ( rec ) => <RecommendationCard key={ `${ rec.type }-${ rec.id }` } rec={ rec } /> ) }
					</div>
				</section>
			) }

			{ timeline && timeline.length > 0 && (
				<section>
					<h2 style={ { fontSize: 16, marginBottom: 10 } }>فعالیت‌های اخیر</h2>
					<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
						{ timeline.map( ( t, i ) => (
							<div key={ i } style={ { display: 'flex', justifyContent: 'space-between', padding: '8px 4px', borderBottom: '1px solid var(--bc-color-line)', fontSize: 13 } }>
								<span>{ t.label }</span>
								<span className="bc-numeric" style={ { color: 'var(--bc-color-ink-faint)' } }>{ fmtDate( t.createdAt ) }</span>
							</div>
						) ) }
					</div>
				</section>
			) }
		</div>
	);
}
