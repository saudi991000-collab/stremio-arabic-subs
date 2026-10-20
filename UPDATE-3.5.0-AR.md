# تحديث ترجمة النخبة 3.5.0 — الخطوات النهائية

## 1. ارفع الملفات

1. فك ضغط `arabic-elite-subtitles-v3.5.0-final.zip`.
2. افتح مستودع `stremio-arabic-subs` في GitHub.
3. اضغط **Add file > Upload files**.
4. اسحب **كل محتويات المجلد المفكوك** إلى صفحة الرفع، وليس ملف ZIP نفسه.
5. تأكد أن `package.json` و`render.yaml` ظهرا في الجذر وأن الملفات الجديدة ظهرت تحت `src/providers/`.
6. اكتب `Arabic Elite Subtitles 3.5.0 final` ثم اضغط **Commit changes**.

الملفات القديمة المتكررة الموجودة في جذر المستودع مثل `server.js` و`config.js` لا يستخدمها Render؛ التشغيل الصحيح هو `src/server.js`. يمكن تركها، لكن لا تستبدل مجلد `src` بها.

## 2. افحص Render

1. انتظر النشر التلقائي أو اضغط **Manual Deploy > Deploy latest commit**.
2. يجب أن يظهر في السجل: `Arabic Elite Subtitles started` ثم `Your service is live`.
3. افتح `https://arabic-elite-subtitles.onrender.com/health` وتأكد أن `version` تساوي `3.5.0`.

## 3. متغيرات Render

اترك مفاتيحك الحالية. القيم المهمة:

```env
MAX_RESULTS=25
MIN_CONFIDENCE=70
DOWNLOAD_FALLBACKS=6
VALIDATE_BEFORE_LISTING=true
DEEP_ANALYSIS_CANDIDATES=25
MAX_SEARCH_PAGES=4
COMPANION_WAIT_MS=0
ALLOW_MACHINE_TRANSLATED=false
```

إذا كان `ARABICSUBS_API_KEY` يعطي 401 فاحذفه؛ بقية المصادر تعمل بدونه. لا تحتاج مفاتيح لـTheSubtitleDB أوSubf2m أوMora أوSubKong أوMiraiAnime أوStremio v3.

## 4. أعد تثبيت الإضافة مرة واحدة

1. افتح Stremio واحذف نسخة «ترجمة النخبة» القديمة.
2. افتح `https://arabic-elite-subtitles.onrender.com/configure`.
3. اضغط **تثبيت في Stremio**.
4. أغلق Stremio وافتحه من جديد.

سترى الأسماء بالشكل: `1 💪👍` للمطابق، ثم `2` و`3`… للخيارات الأخرى. العدد هو **حتى 25** حسب المتاح الحقيقي للعمل والحلقة.
