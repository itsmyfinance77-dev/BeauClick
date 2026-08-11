<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * BeauClick's AI is a beauty discovery/recommendation assistant, not a
 * medical diagnostic system — it must never diagnose, claim certainty about
 * a condition, or prescribe treatment. This is a narrow, conservative
 * keyword gate on RuleBasedProvider's always-on local path (the one path
 * this codebase can test deterministically); AnthropicProvider carries the
 * same principle as a system-prompt instruction instead, since an external
 * model's actual output can't be mechanically verified here without a live
 * API key (architecture doc §16).
 *
 * Deliberately narrow: ordinary skincare-routine vocabulary ("چرب", "خشک",
 * "جوش") must NOT trigger this — those are exactly the kind of message the
 * discovery engine exists to handle normally. Only genuinely medical-
 * leaning language does.
 */
final class MedicalSafetyGuard {

	private const MEDICAL_SIGNAL_PHRASES = [
		'عفونت',
		'آلرژی شدید',
		'سرطان',
		'تومور',
		'خونریزی',
		'بیماری پوستی',
		'زخم عمیق',
		'تشخیص بده',
		'تشخیص بدید',
		'دارو تجویز',
		'قرص تجویز',
		'واکنش شدید',
		'تب دارم',
	];

	public function is_medical_concern( string $text ): bool {
		foreach ( self::MEDICAL_SIGNAL_PHRASES as $phrase ) {
			if ( str_contains( $text, $phrase ) ) {
				return true;
			}
		}
		return false;
	}

	public function cautious_reply(): string {
		return 'من دستیار زیبایی هستم، نه پزشک، و نمی‌تونم این مورد رو تشخیص بدم. اگر این علائم شدید یا مداوم هستند، بهتره برای ارزیابی دقیق‌تر با پزشک یا متخصص مربوطه مشورت کنی. اگر بخوای می‌تونم برای مراقبت عمومی پوست یا مو راهنماییت کنم.';
	}
}
