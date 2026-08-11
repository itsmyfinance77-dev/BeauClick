export function AccountTab() {
	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>حساب کاربری</h1>
			<div className="bc-card" style={ { padding: 16 } }>
				<p style={ { margin: 0, fontSize: 14, color: 'var(--bc-color-ink-soft)' } }>
					ویرایش اطلاعات حساب و آدرس‌ها از طریق صفحه «حساب کاربری» ووکامرس در دسترس است.
				</p>
				<a href="/my-account/" className="bc-btn bc-btn--outline" style={ { marginTop: 12, display: 'inline-block' } }>
					رفتن به حساب کاربری
				</a>
			</div>
		</div>
	);
}
