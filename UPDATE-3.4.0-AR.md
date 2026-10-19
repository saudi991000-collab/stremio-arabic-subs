# تحديث ترجمة النخبة 3.4.0

هذا التحديث لا يحذف المصادر الحالية. يضيف إليها:

- Wyzie (يتطلب `WYZIE_API_KEY`)
- SubKong (يعمل تلقائيًا)
- MiraiAnime لترجمات الأنمي المنسقة ASS (يعمل تلقائيًا)
- AniKoto للأنمي الحديث (يعمل تلقائيًا)

## طريقة الرفع

1. فك ضغط ملف `arabic-elite-subtitles-v3.4.0-update.zip`.
2. افتح مستودع GitHub ثم اختر **Add file > Upload files**.
3. ارفع **المحتويات الموجودة داخل المجلد** إلى جذر المستودع، وليس ملف ZIP نفسه.
4. وافق على استبدال الملفات الموجودة ثم اضغط **Commit changes**.
5. في Render افتح الخدمة ثم **Environment > Add Environment Variable**.
6. الاسم: `WYZIE_API_KEY` والقيمة: مفتاح Wyzie الخاص بك، ثم **Save Changes**.
7. انتظر حتى يصبح النشر **Live**.
8. افتح `https://arabic-elite-subtitles.onrender.com/health` وتأكد أن الإصدار `3.4.0` وأن قائمة المصادر تتضمن `wyzie`, `subkong`, `miraianime`, `anikoto`.
9. في Stremio احذف النسخة القديمة من الإضافة ثم ثبّت:
   `https://arabic-elite-subtitles.onrender.com/manifest.json`

ملاحظة: العدد الأقصى 25، لكنه يعرض فقط الترجمات العربية التي أمكن تنزيلها وفحصها بنجاح، لذلك قد يكون العدد أقل عندما لا تتوفر 25 ترجمة صالحة للعمل نفسه.
