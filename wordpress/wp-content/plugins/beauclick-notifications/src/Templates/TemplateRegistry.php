<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Templates;

/**
 * A small, code-defined template catalog -- not a DB-configurable CMS
 * (the task's own "do not create a huge template catalog" instruction, and
 * there is no real product need yet for an admin to edit message copy
 * outside a deploy). Every template renders three things from the same
 * variable set: a subject (email), an SMS body (plain text, no HTML --
 * §11's explicit "do not inject raw HTML into SMS"), and an email body.
 * `{{variable}}` substitution only -- no template engine, nothing that
 * could execute.
 */
final class TemplateRegistry {

	public const BOOKING_REMINDER         = 'booking_reminder';
	public const WAITLIST_SLOT_AVAILABLE  = 'waitlist_slot_available';
	public const REBOOKING_SUGGESTION     = 'rebooking_suggestion';
	public const RETENTION_NUDGE          = 'retention_nudge';
	public const REFERRAL_REWARDED        = 'referral_rewarded';

	/** @return array{subject:string, sms:string, email:string}|null */
	public static function render( string $key, array $vars ): ?array {
		$template = self::definitions()[ $key ] ?? null;
		if ( ! $template ) {
			return null;
		}

		return [
			'subject' => self::substitute( $template['subject'], $vars ),
			'sms'     => self::substitute( $template['sms'], $vars ),
			'email'   => self::substitute( $template['email'], $vars ),
		];
	}

	/** @return array<string, array{subject:string, sms:string, email:string}> */
	private static function definitions(): array {
		return [
			self::BOOKING_REMINDER => [
				'subject' => __( 'یادآوری نوبت — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'یادآوری BeauClick: نوبت شما با {{providerName}} فردا {{when}} است.', 'beauclick-notifications' ),
				'email'   => __( "سلام {{customerName}}،\n\nیادآوری می‌کنیم نوبت شما با {{providerName}} در {{when}} است.\n\nBeauClick", 'beauclick-notifications' ),
			],
			self::WAITLIST_SLOT_AVAILABLE => [
				'subject' => __( 'زمان مورد نظر شما باز شد — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'BeauClick: یک زمان جدید با {{providerName}} برای {{when}} باز شد. برای رزرو: {{bookingUrl}}', 'beauclick-notifications' ),
				'email'   => __( "سلام {{customerName}}،\n\nخبر خوب! یک زمان جدید با {{providerName}} برای {{when}} باز شده است.\n\nبرای رزرو: {{bookingUrl}}\n\nBeauClick", 'beauclick-notifications' ),
			],
			self::REBOOKING_SUGGESTION => [
				'subject' => __( 'وقت نوبت بعدی‌ات رسیده — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'BeauClick: وقت آن رسیده دوباره نوبت {{serviceName}} با {{providerName}} بگیری. رزرو: {{bookingUrl}}', 'beauclick-notifications' ),
				'email'   => __( "سلام {{customerName}}،\n\nاز آخرین نوبت {{serviceName}} شما با {{providerName}} مدتی می‌گذرد -- وقت آن رسیده دوباره رزرو کنی.\n\nرزرو دوباره: {{bookingUrl}}\n\nBeauClick", 'beauclick-notifications' ),
			],
			self::RETENTION_NUDGE => [
				'subject' => __( 'دلمان برایت تنگ شده — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'BeauClick: مدتی است سراغمان نیامده‌ای! برای رزرو نوبت جدید: {{bookingUrl}}', 'beauclick-notifications' ),
				'email'   => __( "سلام {{customerName}}،\n\nمدتی است نوبتی با BeauClick نداشته‌ای. هر وقت دلت خواست، منتظرتیم.\n\n{{bookingUrl}}\n\nBeauClick", 'beauclick-notifications' ),
			],
			self::REFERRAL_REWARDED => [
				'subject' => __( 'امتیاز معرفی شما واریز شد — BeauClick', 'beauclick-notifications' ),
				'sms'     => __( 'BeauClick: {{points}} امتیاز بابت معرفی موفق به حساب وفاداری شما اضافه شد.', 'beauclick-notifications' ),
				'email'   => __( "سلام،\n\nخبر خوب! {{points}} امتیاز بابت معرفی موفق به حساب وفاداری شما اضافه شد.\n\nBeauClick", 'beauclick-notifications' ),
			],
		];
	}

	private static function substitute( string $text, array $vars ): string {
		$replacements = [];
		foreach ( $vars as $key => $value ) {
			$replacements[ '{{' . $key . '}}' ] = (string) $value;
		}
		return strtr( $text, $replacements );
	}
}
