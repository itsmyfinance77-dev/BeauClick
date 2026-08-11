<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\MedicalSafetyGuard;
use WP_UnitTestCase;

final class MedicalSafetyGuardTest extends WP_UnitTestCase {

	public function test_a_medical_signal_phrase_is_flagged(): void {
		$guard = new MedicalSafetyGuard();
		$this->assertTrue( $guard->is_medical_concern( 'فکر کنم پوستم عفونت کرده، چیکار کنم؟' ) );
	}

	/**
	 * Ordinary skincare-routine vocabulary is exactly what the discovery
	 * engine exists to handle normally -- it must never be mistaken for a
	 * medical concern, or the assistant would refuse the roadmap's own
	 * primary use case.
	 */
	public function test_ordinary_skincare_vocabulary_is_not_flagged(): void {
		$guard = new MedicalSafetyGuard();
		$this->assertFalse( $guard->is_medical_concern( 'برای پوست چرب و جوش‌دار یه روتین ساده می‌خوام' ) );
	}

	public function test_unrelated_text_is_not_flagged(): void {
		$guard = new MedicalSafetyGuard();
		$this->assertFalse( $guard->is_medical_concern( 'دنبال یک آرایشگر خوب برای عروسی هستم' ) );
	}

	public function test_cautious_reply_never_diagnoses_or_prescribes(): void {
		$reply = ( new MedicalSafetyGuard() )->cautious_reply();

		$this->assertStringContainsString( 'پزشک', $reply );
		$this->assertStringNotContainsString( 'تشخیص می‌دم', $reply );
		$this->assertStringNotContainsString( 'قرص', $reply );
	}
}
