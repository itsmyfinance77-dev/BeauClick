#!/usr/bin/env python3
"""Builds `Prototype - Workspace Shell and Dashboards.dc.html` for the #45 pack.

    python3 tools/build_prototype.py        # from the pack root; rewrites the prototype

Why a builder rather than a hand-edited file: the prototype repeats a handful of
patterns (artboard frame, field slot, unavailable block, access badge) across
thirteen sections, and a hand-edited copy drifts -- one slot renamed in one place
and not another is exactly the kind of error the traceability check exists to
catch. Every value slot is a WIRE FIELD NAME from traceability.json, never a
number, so the prototype hard-codes no amount, count, percentage or date.

The output uses the same `<x-dc>` document format, runtime (`support.js`) and
self-hosted fonts as the sibling `v3.3-gap-pack/`, referenced rather than
copied so the branch does not carry a third copy of the font files.
"""
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
OUT = PACK / "Prototype - Workspace Shell and Dashboards.dc.html"

# Palette: the corrected design-language tokens (V3_DESIGN_SYSTEM §10 as
# re-measured by contrast.spec.ts). Muted text is darkened from the pack's
# historical 0.58 to 0.47 so small text clears 4.5:1 on every surface used.
CSS = r"""
  @font-face { font-family: 'Vazirmatn'; src: url('../v3.3-gap-pack/fonts/Vazir-Regular.ttf') format('truetype'); font-weight: 400; font-display: swap; }
  @font-face { font-family: 'Vazirmatn'; src: url('../v3.3-gap-pack/fonts/Vazir-Medium.ttf') format('truetype'); font-weight: 500; font-display: swap; }
  @font-face { font-family: 'Vazirmatn'; src: url('../v3.3-gap-pack/fonts/Vazir-Bold.ttf') format('truetype'); font-weight: 600 700; font-display: swap; }
  @font-face { font-family: 'Vazirmatn'; src: url('../v3.3-gap-pack/fonts/Vazir-Black.ttf') format('truetype'); font-weight: 800 900; font-display: swap; }
  @font-face { font-family: 'Anjoman'; src: url('../v3.3-gap-pack/fonts/Anjoman-Bold.ttf') format('truetype'); font-weight: 700; font-display: swap; }
  @font-face { font-family: 'Anjoman'; src: url('../v3.3-gap-pack/fonts/Anjoman-ExtraBold.ttf') format('truetype'); font-weight: 800; font-display: swap; }
  @font-face { font-family: 'Peyda'; src: url('../v3.3-gap-pack/fonts/Peyda-Bold.ttf') format('truetype'); font-weight: 700 900; font-display: swap; }
  body { margin: 0; background: oklch(0.94 0.005 60); color: oklch(0.22 0.02 330); font-family: 'Vazirmatn', system-ui, sans-serif; }
  a { color: oklch(0.42 0.13 340); }
  a:focus-visible, button:focus-visible, input:focus-visible + .opt, [tabindex]:focus-visible { outline: 2px solid oklch(0.42 0.13 340); outline-offset: 2px; }
  code, .ltr { direction: ltr; unicode-bidi: isolate; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  .doc { padding: 40px; display: flex; flex-direction: column; gap: 56px; }
  .lede { max-width: 940px; display: flex; flex-direction: column; gap: 10px; }
  .kicker { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; color: oklch(0.47 0.015 330); }
  h1.title { margin: 0; font-family: 'Peyda', sans-serif; font-size: 40px; font-weight: 800; line-height: 1.4; }
  .p { margin: 0; font-size: 15px; line-height: 1.9; color: oklch(0.36 0.02 330); }
  .pills { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
  .pill { padding: 5px 12px; border-radius: 999px; background: #fff; border: 1px solid oklch(0.88 0.008 60); }
  section.s { display: flex; flex-direction: column; gap: 16px; }
  .sh { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 800; padding: 4px 10px; border-radius: 999px; background: oklch(0.42 0.13 340); color: #fff; }
  h2.st { margin: 0; font-family: 'Anjoman', sans-serif; font-size: 23px; font-weight: 800; }
  .sub { font-size: 12.5px; color: oklch(0.47 0.015 330); }
  .row { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
  .board { box-sizing: border-box; background: oklch(0.985 0.003 75); border: 1px solid oklch(0.88 0.008 60); border-radius: 14px; overflow: hidden; }
  .desk { width: min(1280px, 100%); }
  .tab { width: min(768px, 100%); }
  .phone { width: 390px; max-width: 100%; border: 10px solid oklch(0.2 0.02 330); border-radius: 34px; }
  .cap { font-size: 11.5px; font-weight: 700; color: oklch(0.47 0.015 330); padding: 6px 12px; background: oklch(0.955 0.004 60); border-bottom: 1px solid oklch(0.88 0.008 60); }
  .hdr { display: flex; align-items: center; gap: 16px; padding: 10px 20px; background: #fff; border-bottom: 1px solid oklch(0.88 0.008 60); flex-wrap: wrap; }
  .brand { font-weight: 800; font-size: 16px; }
  .prim { display: flex; gap: 16px; font-size: 14px; }
  .prim a { color: oklch(0.3 0.02 330); text-decoration: none; }
  .grow { flex: 1; }
  .ctx { font-size: 12.5px; font-weight: 700; padding: 4px 10px; border-radius: 8px; background: oklch(0.95 0.03 340); color: oklch(0.36 0.1 340); border: 1px solid oklch(0.82 0.06 340); }
  .iconbtn { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; border: 1px solid oklch(0.88 0.008 60); background: #fff; font: inherit; font-size: 13px; color: oklch(0.3 0.02 330); gap: 6px; padding: 0 10px; }
  .menu { position: relative; background: #fff; border: 1px solid oklch(0.85 0.01 60); border-radius: 12px; box-shadow: 0 8px 24px oklch(0.2 0.02 330 / 0.12); width: 290px; max-width: 100%; }
  .menu h3 { margin: 0; padding: 10px 14px 4px; font-size: 12px; color: oklch(0.47 0.015 330); }
  .menu ul { list-style: none; margin: 0; padding: 4px 6px 8px; }
  .menu li a { display: flex; min-height: 44px; align-items: center; justify-content: space-between; padding: 0 10px; border-radius: 8px; color: oklch(0.25 0.02 330); text-decoration: none; font-size: 14px; }
  .menu li a[aria-current] { background: oklch(0.95 0.03 340); font-weight: 700; }
  .body { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
  .card { background: #fff; border: 1px solid oklch(0.88 0.008 60); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .card h3, .card h4 { margin: 0; font-size: 15px; font-weight: 800; }
  .kv { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13.5px; padding: 6px 0; border-bottom: 1px dashed oklch(0.9 0.006 60); }
  .kv:last-child { border-bottom: 0; }
  .kv > span:first-child { color: oklch(0.36 0.02 330); }
  .slot { direction: ltr; unicode-bidi: isolate; font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: oklch(0.95 0.02 250); color: oklch(0.32 0.08 250); border: 1px solid oklch(0.84 0.04 250); white-space: nowrap; }
  .unit { font-size: 12px; color: oklch(0.47 0.015 330); }
  .unavail { border: 2px dashed oklch(0.6 0.02 330); border-radius: 12px; padding: 12px 14px; background: oklch(0.975 0.003 330); font-size: 13px; line-height: 1.8; }
  .unavail strong { display: block; font-size: 13.5px; }
  .own { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; }
  .own::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: oklch(0.3 0.02 330); }
  .del { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; }
  .del::before { content: ''; width: 9px; height: 9px; border: 2px solid oklch(0.3 0.02 330); background: transparent; }
  fieldset { border: 1px solid oklch(0.88 0.008 60); border-radius: 12px; margin: 0; padding: 10px 12px 12px; background: #fff; }
  legend { font-size: 13px; font-weight: 800; padding: 0 6px; }
  .opt { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 10px; border: 1px solid oklch(0.88 0.008 60); border-radius: 10px; margin-top: 8px; }
  .opt input { width: 20px; height: 20px; margin: 0; accent-color: oklch(0.42 0.13 340); }
  .opt .nm { font-weight: 700; font-size: 14px; }
  .opt .meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: oklch(0.36 0.02 330); }
  .hint { font-size: 12px; color: oklch(0.47 0.015 330); line-height: 1.8; margin: 6px 0 0; }
  .note { width: min(1280px, 100%); box-sizing: border-box; border: 2px dashed oklch(0.62 0.02 330); border-radius: 14px; padding: 14px 18px; background: repeating-linear-gradient(135deg, oklch(0.975 0.004 330) 0 10px, oklch(0.96 0.006 330) 10px 20px); font-size: 13px; line-height: 1.9; }
  .note h3 { margin: 0 0 4px; font-size: 13.5px; }
  .note ul { margin: 0; padding-inline-start: 18px; }
  .btn { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid oklch(0.42 0.13 340); background: oklch(0.42 0.13 340); color: #fff; font: inherit; font-weight: 700; font-size: 14px; }
  .btn.sec { background: #fff; color: oklch(0.42 0.13 340); }
  .alert { border: 1px solid oklch(0.7 0.12 25); background: oklch(0.97 0.02 25); border-radius: 10px; padding: 10px 12px; font-size: 13px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .skel { height: 14px; border-radius: 6px; background: oklch(0.92 0.004 60); }
  .adminbar { background: oklch(0.22 0.02 330); color: oklch(0.86 0.012 330); display: flex; align-items: center; gap: 16px; padding: 8px 18px; flex-wrap: wrap; }
  .adminbar .mode { font-weight: 800; font-size: 13.5px; color: #fff; }
  .adminbar nav { display: flex; gap: 4px; overflow-x: auto; }
  .adminbar nav a { color: oklch(0.88 0.012 330); text-decoration: none; font-size: 13px; padding: 0 10px; min-height: 44px; display: inline-flex; align-items: center; border-radius: 8px; white-space: nowrap; }
  .adminbar nav a[aria-current] { background: oklch(0.32 0.03 330); color: #fff; box-shadow: inset 0 -2px 0 oklch(0.78 0.1 70); }
  .adminbar a:focus-visible { outline-color: oklch(0.85 0.1 70); }
  .scope { font-size: 11.5px; padding: 3px 8px; border-radius: 6px; border: 1px solid oklch(0.5 0.03 330); color: oklch(0.9 0.01 330); }
  .qgrid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .qcard { background: #fff; border: 1px solid oklch(0.88 0.008 60); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
  .qcard h2 { margin: 0; font-size: 15px; font-weight: 800; font-family: inherit; }
  .qcard a { font-size: 13.5px; font-weight: 700; min-height: 44px; display: inline-flex; align-items: center; }
  .zero { color: oklch(0.38 0.09 150); font-weight: 700; font-size: 13px; }
  .tabbar { display: flex; justify-content: space-around; border-top: 1px solid oklch(0.88 0.008 60); background: #fff; }
  .tabbar a { min-height: 56px; min-width: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 11.5px; color: oklch(0.36 0.02 330); text-decoration: none; }
  .tabbar a[aria-current] { color: oklch(0.42 0.13 340); font-weight: 800; }
  .img { aspect-ratio: 4 / 3; border-radius: 10px; background: repeating-linear-gradient(45deg, oklch(0.93 0.01 250) 0 12px, oklch(0.9 0.012 250) 12px 24px); display: flex; align-items: center; justify-content: center; font-size: 12px; color: oklch(0.36 0.04 250); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  caption { caption-side: top; text-align: start; font-size: 12.5px; color: oklch(0.4 0.015 330); padding: 8px 0; }
  th, td { text-align: start; padding: 8px 10px; border-bottom: 1px solid oklch(0.9 0.006 60); vertical-align: top; }
  th { font-size: 12px; color: oklch(0.36 0.02 330); }
  .band { display: flex; gap: 12px; flex-wrap: wrap; }
  .band > * { flex: 1 1 260px; min-width: 0; }
  .card, .body, .board { min-width: 0; }
  .btn:disabled { background: oklch(0.93 0.004 330); border-color: oklch(0.78 0.01 330); color: oklch(0.42 0.015 330); cursor: not-allowed; }
  .tscroll { overflow-x: auto; max-width: 100%; }
  .tscroll .slot { white-space: nowrap; overflow-wrap: normal; }
  .kv > span:last-child { min-width: 0; overflow-wrap: anywhere; text-align: end; }
  .slot { white-space: normal; overflow-wrap: anywhere; }
"""


CUR = ' aria-current="page"'


def slot(field):
    return f'<span class="slot">‹{field}›</span>'


def kv(label, field, unit=False):
    u = ' <span class="unit">تومان</span>' if unit else ""
    return f'<div class="kv"><span>{label}</span><span>{slot(field)}{u}</span></div>'


def unavailable(title, why, ref=None):
    r = f' <code>{ref}</code>' if ref else ""
    return f'<div class="unavail" role="note"><strong>{title}</strong>{why}{r}</div>'


def section(sid, badge, title, sub, body):
    return f"""
  <section class="s" id="{sid}" data-screen-label="{badge}" aria-labelledby="{sid}-h">
    <div class="sh"><span class="badge">{badge}</span><h2 class="st" id="{sid}-h">{title}</h2><span class="sub">{sub}</span></div>
{body}
  </section>"""


def note(title, items):
    li = "".join(f"<li>{i}</li>" for i in items)
    return f'<div class="note" role="note"><h3>{title}</h3><ul>{li}</ul></div>'


def header(ctx=None, chat=True):
    c = f'<span class="ctx">{ctx}</span>' if ctx else ""
    m = '<button type="button" class="iconbtn" aria-label="پیام‌ها">پیام‌ها ' + slot("total") + "</button>" if chat else ""
    return f"""<div class="hdr"><span class="brand">BeauClick</span>
      <nav class="prim" aria-label="ناوبری اصلی"><a href="#s1">خدمات</a><a href="#s1">متخصص‌ها</a><a href="#s3" aria-current="page">حساب من</a></nav>
      <span class="grow"></span>{c}{m}
      <button type="button" class="iconbtn" aria-label="اعلان‌ها">اعلان‌ها {slot('unreadCount')}</button>
      <button type="button" class="iconbtn" aria-expanded="true" aria-controls="menu-demo">{slot('displayName')}</button></div>"""


def menu(entries, mid="menu-demo"):
    lis = "".join(
        f'<li><a href="#s1"{CUR if cur else ""}>{lab}<span class="sub">{why}</span></a></li>'
        for lab, why, cur in entries
    )
    return f'<div class="menu" id="{mid}"><h3>رفتن به</h3><ul>{lis}</ul></div>'


def board(kind, caption, inner):
    return f'<div class="board {kind}"><div class="cap">{caption}</div>{inner}</div>'


def adminbar(mode, links, scopes, current="/admin"):
    a = "".join(
        f'<a href="#s8"{CUR if href == current else ""}>{lab}</a>' for href, lab in links
    )
    s = "".join(f'<span class="scope">{x}</span>' for x in scopes)
    return f"""<div class="adminbar"><span class="mode">{mode}</span><nav aria-label="ناوبری مدیریت">{a}</nav><span class="grow"></span>{s}<a href="#s1" style="color:oklch(0.88 0.012 330)">خروج از پنل</a></div>"""


def qcard(title, field, href, extra=""):
    return f"""<li class="qcard"><h2>{title}</h2><div>{slot(field)} <span class="sub">مورد در صف</span></div>{extra}<a href="#s10">رفتن به صف {title}</a></li>"""


S = []

S.append(section("s1", "S۱", "یک پوسته، چند بستر", "هدر، منوی آواتار و جابه‌جاییِ بستر — ۱۲۸۰ و ۳۹۰", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · مالکِ دوگانه (متخصص + کسب‌وکار) با دسترسیِ مالی — بسترِ «حساب من»', header() + '<div class="body"><div class="row">' + menu([
        ('نمای مشتری', 'همیشه', True),
        ('حالت متخصص', 'roles ⊇ professional', False),
        ('کسب‌وکار من', 'همیشه؛ صفحه خودش تعیین می‌کند', False),
        ('امور مالی', 'همیشه (#152)', False),
      ]) + menu([
        ('نمای مشتری', 'همیشه', True),
        ('کسب‌وکار من', '', False),
        ('امور مالی', '', False),
        ('بررسی محتوا', 'فقط bc_moderate_* — بدون bc_manage_platform', False),
      ], 'menu-mod') + '</div><p class="hint">منوی دوم: همان پوسته برای یک ناظرِ محتوا. «حالت متخصص» غایب است، نه غیرفعال. «مدیریت» برای دارندهٔ <code>bc_manage_platform</code> و «بررسی محتوا» برای ناظر — یک مسیر، یک پوسته، دو برچسب.</p></div>')}
      {board('phone', '۳۹۰ · مشتری', '<div class="hdr"><span class="brand">BeauClick</span><span class="grow"></span><button type="button" class="iconbtn" aria-label="اعلان‌ها">' + slot('unreadCount') + '</button></div><div class="body"><div class="card"><h3>حساب</h3><a href="#s1">حالت متخصص</a><a href="#s1">کسب‌وکار من</a><a href="#s1">امور مالی</a></div></div><nav class="tabbar" aria-label="ناوبری پایین"><a href="#s1">خانه</a><a href="#s1">جست‌وجو</a><a href="#s1">رزروها</a><a href="#s1">باشگاه</a><a href="#s1" aria-current="page">حساب</a></nav>')}
    </div>
    {note('یادداشتِ طراحی — S۱', [
      'بستر از پیشوندِ مسیر می‌آید؛ هویت یکی است: <code>GET /v1/me</code> → <code>roles</code>, <code>capabilities</code> که زنده خوانده می‌شود.',
      'ترتیبِ منو ثابت است: مشتری · متخصص · کسب‌وکار · مالی · مدیریت. بستری که در دسترس نیست حذف می‌شود؛ هیچ ورودیِ غیرفعالی کشیده نمی‌شود.',
      'پیام‌ها فقط با <code>bc_use_chat</code>؛ عدد از <code>GET /v1/chat/unread-count</code> → <code>total</code>. خطا یعنی بدونِ نشان، نه عددِ حدسی.',
      'پنهان‌کردن یک ورودی کنترلِ امنیتی نیست؛ هر مسیر و هر API بررسیِ خودش را دارد.',
    ])}"""))

sel_multi = f"""<fieldset><legend>کدام فضای کاری؟</legend>
      <label class="opt"><input type="radio" name="ws"> <span><span class="nm">{slot('displayLabel')}</span><span class="meta"><span>کسب‌وکار</span><span class="own">مالک</span></span></span></label>
      <label class="opt"><input type="radio" name="ws"> <span><span class="nm">{slot('displayLabel')}</span><span class="meta"><span>تخصصی</span><span class="own">مالک</span></span></span></label>
      <label class="opt"><input type="radio" name="ws"> <span><span class="nm">{slot('displayLabel')}</span><span class="meta"><span>کسب‌وکار</span><span class="del">فقط‌خواندنی — دسترسیِ واگذارشده</span></span></span></label>
      <p class="hint">انتخاب فقط در همین صفحه نگه داشته می‌شود؛ پس از بارگذاریِ دوباره دوباره پرسیده می‌شود. شناسهٔ فضا هرگز نمایش داده یا ذخیره نمی‌شود.</p></fieldset>"""
S.append(section("s2", "S۲", "جابه‌جاییِ فضای کاری", "GET /v1/me/finance/workspaces · هیچ پیش‌انتخابی", f"""
    <div class="row">
      {board('tab', '۷۶۸ · چند فضا — انتخابِ صریح لازم است', '<div class="body">' + sel_multi + '<div aria-live="polite" class="sub">فضای کاری: ' + slot('displayLabel') + '</div></div>')}
      {board('phone', '۳۹۰ · حالت‌ها', '<div class="body"><div class="card" aria-busy="true"><h3>در حال بارگذاری فضاها</h3><div class="skel"></div><div class="skel" style="width:70%"></div></div><div class="card"><h3>فضای کاری‌ای در دسترس نیست</h3><p class="p">حسابِ شما به هیچ فضای مالی دسترسی ندارد. این یک پاسخ درست است، نه خطا.</p></div><div class="alert" role="alert"><span>فهرستِ فضاها خوانده نشد.</span><button type="button" class="btn sec">تلاش دوباره</button></div><div class="card"><h3>کدام فضای کاری؟</h3><p class="p">برای ادامه یک فضا را انتخاب کنید. <span class="sub">(پاسخِ ۴۰۹ — هرگز نمی‌گوید کدام یا چند فضا)</span></p></div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۲', [
      'یک فضا ← بدونِ انتخاب‌گر، مستقیم باز می‌شود. چند فضا ← هیچ‌چیز انتخاب نمی‌شود تا کاربر انتخاب کند.',
      'دسترسی با متن + شکل: دایرهٔ پُر «مالک»، مربعِ توخالی «فقط‌خواندنی». نه فقط رنگ.',
      'در فهرستِ اشتراک‌ها (<code>GET /v1/me/subscriptions</code>) برچسبی نیست؛ چون هر مالک حداکثر یک فضای هر نوع دارد (<code>uq_professionals_owner_id</code>, <code>uq_businesses_owner_id</code>)، <code>workspaceType</code> آن را یکتا نام می‌برد. شناسه‌ها میان سطوح مقایسه نمی‌شوند.',
      'با تغییرِ فضا، دادهٔ فضای قبلی پیش از نمایشِ فضای بعدی پاک می‌شود.',
    ])}"""))

S.append(section("s3", "S۳", "مشتری — پول روی نوبتِ پیش‌رو", "GET /v1/orders/:id · paymentSchedule", f"""
    <div class="row">
      {board('phone', '۳۹۰ · پیش‌پرداختِ آنلاین، باقی در محل', '<div class="body"><div class="card"><h3>نوبتِ پیش‌رو</h3><div class="kv"><span>شیوهٔ دریافت</span><span>' + slot('collectionMode') + '</span></div><p class="sub">مبالغ به تومان</p>' + kv('مبلغ خدمت', 'serviceTotalToman') + kv('مبلغِ پرداختِ آنلاین', 'platformCollectibleNowToman') + kv('باقی‌مانده، پرداخت در محل', 'venueBalanceToman') + kv('پرداخت‌شده', 'collectedTotalToman') + '</div><div class="card"><h3>فروشندهٔ خدمت</h3><div class="kv"><span>نام و نوع</span><span>از snapshot سفارش</span></div><div class="unavail" role="note"><strong>متن شرایط هنوز منتشر نشده است.</strong>جملهٔ مسئولیت‌ها فقط از متنِ منتشرشدهٔ مدیریت می‌آید (صفحهٔ ۴۷).</div></div></div>')}
      {board('phone', '۳۹۰ · نوبت بدونِ سفارش', '<div class="body"><div class="card"><h3>نوبتِ پیش‌رو</h3><div class="kv"><span>زمان</span><span>' + slot('startAt') + '</span></div><p class="hint">این نوبت سفارشی ندارد (<code>orderId: null</code>)؛ هیچ ردیفِ پولی کشیده نمی‌شود — نه «۰».</p></div>' + unavailable('ثبت اعتراض در این نسخه فعال نیست.', 'مسیری برای ثبتِ اعتراض وجود ندارد.', '#162') + '</div>')}
    </div>
    {note('یادداشتِ طراحی — S۳', [
      '<code>collectionMode</code> واژگانِ بسته دارد: <code>pay_at_venue</code> · <code>deposit_online_balance_at_venue</code> · <code>full_payment_online</code>. مقدارِ ناشناخته «نامشخص» است.',
      'فقط <code>collectedTotalToman</code> «پرداخت‌شده» نامیده می‌شود. <code>venueBalanceToman</code> رقمِ برنامه است؛ بیوکلیک پرداختِ در محل را ثبت نمی‌کند.',
      'هیچ مبلغی در کلاینت از مبلغِ دیگر کم یا جمع نمی‌شود. واحد یک بار در هر بلوک (#294).',
    ])}"""))

S.append(section("s4", "S۴", "متخصص — وضعیتِ تجاری", "GET /v1/me/subscriptions · credit-purchases", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · کارتِ «وضعیت تجاری» در /pro — بدونِ رقمِ مالی', '<div class="body"><div class="band"><div class="card"><h3>طرح</h3>' + kv('وضعیت', 'subscription.state') + kv('طرح', 'displayName') + kv('از', 'effectiveAt') + '<div class="kv"><span>کنش‌ها</span><span>' + slot('availableActions') + '</span></div></div><div class="card"><h3>سهمیهٔ طرح</h3>' + kv('اعتبارِ رزروِ شامل', 'includedBookingCredits') + kv('صندلیِ کارکنان', 'staffSeats') + kv('شعبه', 'includedLocations') + '<p class="hint">صفر یعنی «بدون سهمیه» — نه نامحدود.</p>' + unavailable('میزانِ مصرفِ سهمیه در این نسخه نمایش داده نمی‌شود.', 'هیچ مسیری مصرف را برنمی‌گرداند.') + '</div><div class="card"><h3>اعتبارِ رزرو</h3>' + unavailable('ماندهٔ اعتبارِ رزرو در این نسخه قابلِ نمایش نیست.', 'مانده در سرور محاسبه می‌شود ولی به فروشنده بازگردانده نمی‌شود.') + '<table><caption>خریدها — مبالغ به تومان</caption><thead><tr><th scope="col">تعداد</th><th scope="col">مبلغ</th><th scope="col">وضعیت</th></tr></thead><tbody><tr><td>' + slot('quantity') + '</td><td>' + slot('totalToman') + '</td><td>در انتظار پرداخت — پرداختِ آنلاین هنوز فعال نیست</td></tr></tbody></table></div></div><p class="sub">پول: <a href="#s7">امور مالی</a> — هیچ رقمی در /pro تکرار نمی‌شود.</p></div>')}
    </div>
    <div class="row">
      {board('phone', '۳۹۰ · طرحی ثبت نشده (subscription: null)', '<div class="body"><div class="card"><h3>طرح</h3><p class="p">طرحی برای این فضا ثبت نشده است.</p><p class="hint">دکمه فقط وقتی کشیده می‌شود که <code>availableActions</code> خالی نباشد.</p></div><div class="card"><h3>خرید اعتبار</h3><p class="p">خرید در حالِ حاضر ممکن نیست.</p><p class="hint">یک پاسخِ یکسان برای هر علت (<code>purchase_unavailable</code>).</p></div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۴', [
      'فعال‌سازیِ پرداختی (#99) و ریلِ پرداخت (#47) بسته‌اند؛ خرید در <code>awaiting_payment</code> می‌ماند.',
      'بازپرداختِ اعتبارِ مصرف‌نشده (<code>V33-DEC-041</code> R6) تا وجودِ ریل و استوری‌اش <strong>غایب</strong> است — این یادداشت جای آینده‌اش را نشان می‌دهد، نه رابط.',
      '<code>bc_manage_own_subscription</code> ممتاز نیست؛ لغوِ آن زنده نیست و طراحی ادعای خلافش را نمی‌کند.',
    ])}"""))

S.append(section("s5", "S۵", "مالکِ کسب‌وکار — عملیات", "همهٔ مسیرهای مالک‌فقط", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · /business برای مالک', '<div class="body"><div class="band"><div class="card"><h3>کسب‌وکار</h3>' + kv('نام', 'displayName') + kv('نوع فعالیت', 'vertical') + '<p class="hint">نوع فعالیت هیچ دسترسی‌ای نمی‌دهد و داشبورد بر اساسش تغییر نمی‌کند.</p></div><div class="card"><h3>اعضا</h3><table><caption>فقط برای مالک — staff-management</caption><thead><tr><th scope="col">عضو</th><th scope="col">نقش</th><th scope="col">دسترسی‌ها</th></tr></thead><tbody><tr><td>' + slot('displayLabel') + '</td><td>' + slot('role') + '</td><td>' + slot('roles') + '</td></tr><tr><td>' + slot('identificationHint') + '</td><td>' + slot('role') + '</td><td>finance_read</td></tr></tbody></table><p class="hint">واژگانِ دسترسی دقیقاً دو عضو دارد: <code>practitioner_chat</code>، <code>finance_read</code>.</p></div><div class="card"><h3>طرح و سهمیه</h3><p class="p">همان کارتِ S۴ برای فضای <strong>کسب‌وکار</strong>.</p><p class="sub">پول: <a href="#s7">امور مالی</a></p></div></div></div>')}
    </div>"""))

S.append(section("s6", "S۶", "مدیر، پذیرش، متخصصِ عضو", "عضویت بدونِ مالکیت", f"""
    <div class="row">
      {board('phone', '۳۹۰ · مدیر (manager)', '<div class="body"><div class="card"><h3>' + slot('displayName') + '</h3><p class="sub">عضو · مدیر</p><button type="button" class="btn sec">ویرایش مشخصات کسب‌وکار</button><p class="p">مدیریتِ اعضا، دسترسی‌ها، شعبه‌ها و منابع فقط با مالکِ کسب‌وکار است.</p></div><div class="card"><h3>امور مالی</h3><p class="p">بدونِ دسترسیِ مالیِ واگذارشده، پولِ کسب‌وکار نمایش داده نمی‌شود.</p></div></div>')}
      {board('phone', '۳۹۰ · پذیرش (staff، بدونِ دسترسی)', '<div class="body"><div class="card"><h3>' + slot('displayName') + '</h3><p class="sub">عضو</p></div>' + unavailable('ثبت و مدیریتِ نوبت برای دیگر اعضا در این نسخه ممکن نیست.', 'اختیارِ واگذارشدهٔ تقویم تصمیمی باز است.', 'V33-DEC-030') + '</div>')}
      {board('phone', '۳۹۰ · متخصصِ عضو با practitioner_chat', '<div class="body"><div class="card"><h3>حالت متخصص</h3><p class="p">نوبت‌ها، زمان‌ها و مالیِ <strong>فضای تخصصیِ خودتان</strong> — نه سالن.</p></div><div class="card"><h3>پیام‌ها</h3><p class="p">گفتگوهای مشتریانی که نزدِ خودِ شما نوبت گرفته‌اند.</p>' + kv('خوانده‌نشده', 'total') + '</div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۶', [
      'مدیر: خواندنِ کسب‌وکار و فهرستِ اعضا، و <code>PATCH /v1/businesses/:id</code> (<code>BusinessManagerResolver</code>). دیگر مسیرها فقط مالک.',
      'نقشِ «پذیرش» وجود ندارد (<code>V33-DEC-033</code> R1): یک عضوِ <code>staff</code> است و طراحی میزِ پذیرش یا تقویمِ مشترک نمی‌کشد.',
      '<code>practitioner_chat</code> فقط گفتگوهای خودِ آن متخصص را باز می‌کند، نه گفتگوی متخصصِ دیگرِ همان سالن (R2).',
      'هیچ دکمهٔ غیرفعالی برای کارهای بی‌اختیار کشیده نمی‌شود — یک جمله کافی است.',
    ])}"""))

S.append(section("s7", "S۷", "امور مالی — مرزِ پول‌ها", "summary · funds · settlements", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · دارندهٔ finance_read — همان داده، فقط‌خواندنی', '<div class="body"><div class="sh"><strong>' + slot('displayLabel') + '</strong><span class="del">فقط‌خواندنی — دسترسیِ واگذارشده</span></div><p class="sub">مبالغ به تومان</p><div class="band"><div class="card"><h3>خلاصهٔ پیشین</h3>' + kv('طلبِ خالصِ شما', 'receivableNetToman') + kv('تسویه‌شده', 'settledToman') + kv('تسویه‌نشده', 'outstandingToman') + '</div><div class="card"><h3>پولِ این فضا</h3>' + kv('در انتظار', 'pending') + kv('درگیرِ اختلاف', 'disputed') + kv('قابلِ تسویه', 'available') + kv('ذخیره', 'reserve') + kv('تسویه‌شده', 'settled') + kv('بازگردانده‌شده', 'refunded') + '</div><div class="card" style="border-style:dashed"><h3>واقعیتِ امانت — نه ماندهٔ شما</h3>' + kv('وصول‌شده', 'collected') + kv('پیش‌دادهٔ سکو', 'platformAdvance') + kv('بازیافتِ واردشده', 'recoveredIn') + '</div><div class="card" style="border:2px solid oklch(0.3 0.02 330)"><h3>پولِ سکو — جدا از ارقامِ بالا</h3>' + kv('درآمدِ سکو', 'platformEarned') + kv('کارمزدِ درگاه', 'providerFee') + kv('بازیافتِ خارج‌شده', 'recoveryOut') + '</div></div><p class="p">این گروه‌ها به پرسش‌های متفاوتی پاسخ می‌دهند و با هم جمع نمی‌شوند.</p><div class="band"><div class="card"><table><caption>تسویه‌ها — صفحهٔ کلیددار، بدونِ شمارهٔ صفحه</caption><thead><tr><th scope="col">نوع</th><th scope="col">مبلغ</th><th scope="col">تاریخ</th></tr></thead><tbody><tr><td>تسویه</td><td>' + slot('amountToman') + '</td><td>' + slot('createdAt') + '</td></tr><tr><td>برگشتِ تسویه <span class="sub">(kind = reversal)</span></td><td>' + slot('amountToman') + '</td><td>' + slot('createdAt') + '</td></tr></tbody></table><button type="button" class="btn sec">بیشتر</button></div>' + unavailable('بدهیِ ثبت‌شده به سکو در این نسخه نمایش داده نمی‌شود.', 'این «طلبِ فروشنده» در V33-DEC-040 پولی است که فروشنده بدهکار است — عکسِ «طلبِ خالصِ شما».', '#177') + '</div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۷', [
      'صفحهٔ ۴۶ و اصلاحیه‌اش با اصلاحاتِ R1–R3 بی‌تغییر اعمال می‌شوند؛ اینجا فقط «برگشت» و دو معنای «طلب» افزوده شده.',
      '<code>receivableNetToman</code> = پولی که به فروشنده بدهکاریم. «seller receivable»ِ <code>V33-DEC-040</code> = پولی که فروشنده بدهکار است و وجود ندارد. هرگز یک برچسب، یک کارت یا یک علامت را شریک نمی‌شوند.',
      'نه عدد از نُه میدانِ فروشنده امروز ساختاراً صفرند؛ صفر پاسخِ درست است، نه حالتِ خالی.',
      'هیچ کنترلِ نوشتنی برای دارندهٔ <code>finance_read</code> کشیده نمی‌شود، حتی غیرفعال.',
    ])}"""))

mod_links_full = [("/admin", "صف‌های بررسی"), ("/v", "احراز هویت"), ("/m", "گزارش تصاویر"), ("/r", "بازبینی دیدگاه‌ها"), ("/c", "گزارش گفتگوها")]
mod_scopes_full = ["بررسی احراز هویت", "بررسی تصاویر", "بررسی دیدگاه‌ها", "بررسی گفتگوها"]
chat_extra = '<p class="hint">این مسیر جمعِ کل ندارد: کمتر از حد ← «n گزارش باز»؛ برابرِ حد ← «دست‌کم n».</p>'
landing_full = '<div class="body"><h1 style="margin:0;font-size:22px">صف‌های بررسی</h1><ul class="qgrid">' + qcard('احراز هویت', 'meta.pagination.total', '#') + qcard('گزارش تصاویر', 'meta.pagination.total', '#') + qcard('بازبینی دیدگاه‌ها', 'meta.pagination.total', '#') + '<li class="qcard"><h2>گزارش گفتگوها</h2><div>' + slot('items.length') + ' <span class="sub">گزارشِ باز</span></div>' + chat_extra + '<a href="#s10">رفتن به صف گزارش گفتگوها</a></li></ul></div>'
S.append(section("s8", "S۸", "ناظر — صفحهٔ آغازِ بررسی", "همان پوستهٔ مدیریت، فقط صف‌های در اختیار", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · ناظرِ کامل (چهار bc_moderate_*، بدونِ bc_manage_platform)', adminbar('بیوکلیک — بررسی محتوا', mod_links_full, mod_scopes_full) + landing_full)}
    </div>
    <div class="row">
      {board('tab', '۷۶۸ · ناظرِ جزئی — فقط bc_moderate_media', adminbar('بیوکلیک — بررسی محتوا', [("/admin", "صف‌های بررسی"), ("/m", "گزارش تصاویر")], ["بررسی تصاویر"]) + '<div class="body"><h1 style="margin:0;font-size:22px">صف‌های بررسی</h1><ul class="qgrid"><li class="qcard"><h2>گزارش تصاویر</h2><div class="zero">صف خالی است</div><a href="#s10">رفتن به صف گزارش تصاویر</a></li></ul><p class="hint">بدونِ هدایتِ خودکار: یک کارت، یک کلید تا صف. کارتی برای صفِ ناداشته کشیده نمی‌شود.</p></div>')}
      {board('phone', '۳۹۰ · ناظر — حالت‌های کارت', adminbar('بررسی محتوا', mod_links_full[:3], []) + '<div class="body"><ul class="qgrid"><li class="qcard" aria-busy="true"><h2>احراز هویت</h2><div class="skel"></div></li><li class="qcard"><h2>گزارش تصاویر</h2><div class="alert" role="alert"><span>شمار خوانده نشد.</span><button type="button" class="btn sec">تلاش دوباره</button></div></li></ul></div>')}
    </div>
    {note('یادداشتِ طراحی — S۸ (تصمیمِ تأییدشدهٔ A)', [
      'یک پوسته. دارندهٔ <code>bc_manage_platform</code> نمای کلی را می‌بیند، بی‌تغییر؛ ناظر این صفحه را.',
      'شمار از <code>meta.pagination.total</code> (با <code>limit=1</code>) برای سه صف؛ صفِ گفتگو جمع ندارد.',
      'هرگز: آمارِ پلتفرم، کاربران، گزارشِ عملیات، تسویه، حریم خصوصی، جست‌وجو، اعلان‌ها، تعارض شماره، باشگاه، هر صفحهٔ /admin/commercial.',
      'ترتیب ثابت است و بر اساسِ شمار مرتب نمی‌شود.',
    ])}"""))

S.append(section("s9", "S۹", "لغوِ زندهٔ اختیار", "۴۰۳ → پاک‌کردن → بازخوانیِ /v1/me", f"""
    <div class="row">
      {board('tab', '۷۶۸ · ناظری که bc_moderate_media را همین حالا از دست داد', adminbar('بیوکلیک — بررسی محتوا', [("/admin", "صف‌های بررسی"), ("/v", "احراز هویت")], ["بررسی احراز هویت"]) + '<div class="body"><ul class="qgrid">' + qcard('احراز هویت', 'meta.pagination.total', '#') + '<li class="qcard"><h2>گزارش تصاویر</h2><p class="p" role="alert">دسترسی شما به این صف تغییر کرده است.</p></li></ul><p class="hint">بدونِ «تلاش دوباره» و بدونِ شمارِ پیشین. در خواندنِ بعدیِ <code>/v1/me</code> کارت و پیوندِ نوار حذف می‌شوند.</p></div>')}
    </div>"""))

S.append(section("s10", "S۱۰", "بازرسیِ امنِ تصویرِ گزارش‌شده", "#265 — حالت‌ها، نه شکلِ مسیر", f"""
    <div class="row">
      {board('desk', '۱۲۸۰ · صف + پنلِ تصمیم', adminbar('بیوکلیک — بررسی محتوا', [("/admin", "صف‌های بررسی"), ("/m", "گزارش تصاویر")], ["بررسی تصاویر"], current="/m") + '<div class="body"><div class="band"><div class="card"><table><caption>گزارش‌های باز</caption><thead><tr><th scope="col">تصویر</th><th scope="col">دلیل</th><th scope="col">زمان</th></tr></thead><tbody><tr><td><div class="img" style="width:72px">محافظت‌شده</div></td><td>' + slot('reason') + '</td><td>' + slot('createdAt') + '</td></tr><tr><td><div class="img" style="width:72px">در دسترس نیست</div></td><td>' + slot('reason') + '</td><td>' + slot('createdAt') + '</td></tr></tbody></table></div><div class="card"><h3>تصمیم</h3><div class="img" role="img" aria-label="تصویرِ گزارش‌شده">تصویرِ کامل از نشانیِ محافظت‌شدهٔ کوتاه‌عمر</div><label class="sub" for="why">دلیل (الزامی)</label><textarea id="why" rows="2" style="font:inherit;border:1px solid oklch(0.8 0.01 60);border-radius:8px;padding:8px"></textarea><div class="band"><button type="button" class="btn sec">رد گزارش</button><button type="button" class="btn">تأیید و حذف</button></div></div><div class="card"><h3>تصمیم — تصویر در دسترس نیست</h3><div class="img">تصویر در دسترس نیست</div><div class="band"><button type="button" class="btn sec">رد گزارش</button><button type="button" class="btn" disabled aria-describedby="nodel">تأیید و حذف</button></div><p class="hint" id="nodel">تا نمایشِ تصویر، حذف ممکن نیست.</p></div></div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۱۰', [
      'شکلِ مسیر را #265 در فاز ۲ تعریف می‌کند، به الگوی موجودِ <code>GET /v1/admin/verification/:id/evidence</code> → <code>downloadUrl</code> (<code>issueProtectedDownloadUrl</code>، مخصوصِ همان ناظر). هیچ میدانی اینجا اختراع نشده.',
      '«تأیید و حذف» فقط پس از بارگذاریِ موفقِ تصویر فعال می‌شود؛ برگشت‌ناپذیر است، دلیل می‌خواهد و از <code>ConfirmDialog</code> می‌گذرد. «رد» همیشه ممکن و برگشت‌پذیر است.',
      'نشانی، کلید، سطل، مسیر یا توکن هرگز نمایش، کپی، ثبت یا در خطا و گزارشِ عملیات گذاشته نمی‌شود.',
      'نشانیِ منقضی: یک درخواستِ دوبارهٔ بی‌صدا، بعد «دریافت دوباره».',
    ])}"""))

S.append(section("s11", "S۱۱", "اختلاف، اعتراض، جبران", "هیچ مسیری برای اختلاف وجود ندارد", f"""
    <div class="row">
      {board('phone', '۳۹۰ · مشتری', '<div class="body">' + unavailable('ثبت اعتراض در این نسخه فعال نیست.', 'نه فرم، نه دسته‌بندی، نه شمارشِ معکوسِ مهلت.', '#162 · #180') + '<div class="card"><h3>انتخابِ جبران</h3><p class="p">وقتی خواندنِ جبران می‌گوید انتخابی باز است، ورودیِ صفحهٔ ۴۹ اینجا می‌نشیند.</p><p class="sub"><code>GET /v1/bookings/:id/remedy</code> — #212</p></div></div>')}
      {board('phone', '۳۹۰ · فروشنده', '<div class="body"><div class="card"><h3>پولِ درگیرِ اختلاف</h3>' + kv('درگیرِ اختلاف', 'disputed', unit=True) + '<p class="hint">تا وجودِ اختلاف ساختاراً صفر است.</p></div></div>')}
    </div>
    {note('یادداشتِ طراحی — S۱۱', [
      'صفِ بازبینِ اختلاف و تجدیدنظر به یک اختیارِ ممتازِ تازه نیاز دارد که وجود ندارد (<code>V33-DEC-039</code> R11)؛ پس در صفحهٔ ناظر <strong>غایب</strong> است، نه کارتِ غیرفعال.',
    ])}"""))

S.append(section("s12", "S۱۲", "هفت حالت، یک زبان", "بارگذاری · خالی · خطا · تعارض · ناموجود · لغوِ اختیار · پیکربندیِ ناقص", f"""
    <div class="row">
      {board('desk', 'کاتالوگ حالت‌ها', '<div class="body"><div class="band"><div class="card" aria-busy="true"><h3>بارگذاری</h3><div class="skel"></div><div class="skel" style="width:60%"></div><p class="hint">هرگز رقمِ کهنه زیرِ اسکلت.</p></div><div class="card"><h3>خالی</h3><p class="p">هنوز تسویه‌ای ثبت نشده است.</p><p class="hint">صفر همچنان صفر نمایش داده می‌شود.</p></div><div class="card"><h3>خطا</h3><div class="alert" role="alert"><span>این بخش خوانده نشد.</span><button type="button" class="btn sec">تلاش دوباره</button></div></div><div class="card"><h3>تعارض (۴۰۹)</h3><p class="p">برای ادامه یک فضا را انتخاب کنید.</p></div></div><div class="band"><div class="card"><h3>ناموجود</h3>' + unavailable('ماندهٔ اعتبارِ رزرو در این نسخه قابلِ نمایش نیست.', 'بدونِ عدد، بدونِ تاریخ، بدونِ «به‌زودی».') + '</div><div class="card"><h3>لغوِ اختیار</h3><p class="p" role="alert">دسترسی شما به این بخش تغییر کرده است.</p><a href="#s1">بازگشت</a><p class="hint">بدونِ تلاشِ دوباره؛ داده پاک می‌شود.</p></div><div class="card"><h3>پیکربندیِ ناقص</h3><p class="p">طرحی برای این فضا ثبت نشده است.</p><p class="hint">لحنِ خنثی، نه خطا؛ کنش فقط اگر سرور فهرستش کند.</p></div></div></div>')}
    </div>"""))

HTML = f"""<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeauClick V3.3 — Workspace shell and dashboards (#45)</title>
<script src="../v3.3-gap-pack/support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<meta name="design_doc_mode" content="canvas" />
<style>{CSS}</style>
</helmet>

<main class="doc" dir="rtl" lang="fa">
  <div class="lede">
    <div class="kicker">BEAUCLICK V3.3 — #45 · صفحه‌های ۵۱ و ۵۲</div>
    <h1 class="title">یک پوسته، چند فضا، داشبوردِ مبتنی بر اختیار</h1>
    <p class="p">هر عدد، شمار، تاریخ یا مبلغ در این نمونه به‌صورتِ <strong>نامِ میدانِ سرور</strong> نشان داده شده — مثل {slot('settledToman')} — نه یک رقم. هیچ مبلغ، درصد، مهلت یا جملهٔ حقوقی در این طراحی نوشته نشده است.</p>
    <p class="p">مبنای پیاده‌سازی: <code>master 2e3da4a</code> · مبنای طراحی: <code>design/claude-design 4b5b120</code>. نگاشتِ کاملِ مسیر و میدان: <code>ROUTE_CONTRACT_MATRIX.md</code>.</p>
    <div class="pills"><span class="pill">هیچ میدانی اختراع نشده</span><span class="pill">ناموجود ≠ صفر</span><span class="pill">پنهان‌کردن ≠ مجوز</span><span class="pill">دسترسی با متن + شکل</span></div>
    <nav aria-label="بخش‌ها" class="pills"><a class="pill" href="#s1">S۱ پوسته</a><a class="pill" href="#s2">S۲ فضا</a><a class="pill" href="#s3">S۳ مشتری</a><a class="pill" href="#s4">S۴ متخصص</a><a class="pill" href="#s5">S۵ مالک</a><a class="pill" href="#s6">S۶ اعضا</a><a class="pill" href="#s7">S۷ مالی</a><a class="pill" href="#s8">S۸ ناظر</a><a class="pill" href="#s9">S۹ لغو</a><a class="pill" href="#s10">S۱۰ تصویر</a><a class="pill" href="#s11">S۱۱ اختلاف</a><a class="pill" href="#s12">S۱۲ حالت‌ها</a></nav>
  </div>
{''.join(S)}
</main>
</x-dc>
</body>
</html>
"""

# Every table sits in a keyboard-reachable scroll region named by its own
# caption, so a narrow artboard scrolls the table instead of clipping it.
import re

_n = [0]


def _wrap(m):
    _n[0] += 1
    cid = f"tcap{_n[0]}"
    return (f'<div class="tscroll" tabindex="0" role="region" aria-labelledby="{cid}">'
            f'<table><caption id="{cid}">')


HTML = re.sub(r"<table><caption>", _wrap, HTML).replace("</table>", "</table></div>")
assert HTML.count('class="tscroll"') == HTML.count("<table>"), "a table escaped its scroll region"

OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT.relative_to(PACK)} ({len(HTML.encode())} bytes, {len(S)} sections)")
