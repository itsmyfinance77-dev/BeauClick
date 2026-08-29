# نمای کلی مدیریت — /admin

مسیر: `/admin`

## وضعیت
طراحی محدود — تفکیک صف از آمار.

## دلیل
صفحه امروز پنج منبع را در یک نگاه می‌ریزد بدون سلسله‌مراتب. آمار پلتفرم فقط اطلاع است، صف‌ها کارِ معطل‌اند — این دو باید بخش جدا با تیتر جدا باشند (طبق V3_ADMIN_UX.md §۳).

## API
platformMetrics، verificationQueue، phoneConflicts، notificationStatus، searchStatus — همه IMPLEMENTABLE.
## اجزا
StatGrid برای آمار؛ ردیف صف با شمارنده و لینک مستقیم به هر مقصد صف.