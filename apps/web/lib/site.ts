/**
 * The public company website (glioagency.org): home, privacy policy, terms.
 * Company facts live in COMPANY; a field left null is not shown anywhere.
 * The public brand is "Glio" only: the owner chose not to show the legal entity
 * name on the website (legalName* is kept for platform applications, not rendered).
 * Contact is email only (owner's choice): phone stays null.
 * Text is Arabic-first with an English version; both must have the same shape (tested).
 */

export const COMPANY = {
  legalNameEn: "Sutoor AlMustaqbaliyya Agency for Commercial Services",
  // TODO(owner): confirm the exact Arabic legal name as written on the Commercial Registration.
  legalNameAr: "وكالة سطور المستقبلية",
  tradeNameEn: "GLIO",
  tradeNameAr: "غليو",
  productEn: "Glio",
  productAr: "غليو",
  domain: "glioagency.org",
  email: "info@glioagency.org",
  country: { en: "Kingdom of Saudi Arabia", ar: "المملكة العربية السعودية" },
  // TODO(owner): fill in when the owner decides what to publish.
  city: null as { en: string; ar: string } | null,
  phone: null as string | null,
  crNumber: "7042386917" as string | null,
} as const;

export const POLICY_UPDATED = "2026-11-21";

type Section = { heading: string; paragraphs: string[]; bullets?: string[] };

export const site = {
  ar: {
    navHome: "الرئيسية",
    navServices: "الخدمات",
    navPlatform: "المنصة",
    navDemo: "اطلب عرضًا",
    navPrivacy: "سياسة الخصوصية",
    navTerms: "الشروط والأحكام",
    switchLang: "English",
    signIn: "تسجيل الدخول",
    eyebrow: "عمليات إعلانية · المملكة العربية السعودية",
    heroTitle1: "لا تحتاج إلى تسويق.",
    heroTitle2a: "تحتاج إلى ",
    heroTitle2b: "نتائج.",
    heroText:
      "غليو يجمع فريقًا من مشغّلي الإعلانات مع منصة غليو: وكلاء ذكاء اصطناعي يتابعون حملاتك يوميًا، وأرقام مطابقة للمنصات الإعلانية، وتقارير عربية واضحة. أنت توافق، ونحن ننفّذ.",
    heroCta: "اطلب عرضًا توضيحيًا",
    heroSecondary: "استعرض الخدمات",
    platformsTitle: "نعمل على",
    servicesKicker: "01 / الخدمات",
    servicesTitle: "ثلاث خدمات، فريق واحد.",
    servicesIntro: "نعمل كفريق تسويقك المتكامل: نجهّز بياناتك، وندير إعلاناتك، ونحرص على أن يجدك العملاء في البحث. كمشروع إعداد لمرة واحدة، أو اشتراك شهري، أو الاثنين معًا.",
    services: [
      {
        heading: "إدارة الإعلانات المدفوعة",
        paragraphs: ["إدارة يومية للحملات على ميتا وجوجل وتيك توك وسناب شات: الاستراتيجية، والمزايدة، وإعادة الاستهداف، وتقسيم الجماهير. يتابعها مشغّل يقرأ أرقام مبيعاتك، ويساعده وكلاء غليو، ولا يُنفَّذ أي تغيير على الميزانية دون موافقتك."],
        bullets: ["Meta", "Google", "TikTok", "Snapchat"],
      },
      {
        heading: "إعداد التتبع والبيانات",
        paragraphs: ["نجهّز منظومة التحليلات والبكسلات قبل تشغيل أول إعلان: GA4 وGoogle Tag Manager وبكسلات ميتا وتيك توك وسناب، والتتبع من جهة الخادم، ومعايير UTM، وربط Search Console وMerchant Center."],
        bullets: ["GA4", "GTM", "Pixels", "Server-side"],
      },
      {
        heading: "تحسين الظهور في البحث",
        paragraphs: ["استراتيجية كلمات مفتاحية مطبّقة على صفحاتك ومنتجاتك، وبيانات منظّمة، وإعداد Search Console وMerchant Center، والظهور المحلي عبر خرائط جوجل وملف النشاط التجاري."],
        bullets: ["Keywords", "Schema", "Local SEO", "Maps"],
      },
    ] as Section[],
    platformKicker: "02 / المنصة",
    platformTitle: "منصة غليو",
    platformIntro: "المنصة التي يعمل عليها فريقنا، ومتاحة لعملائنا: نبدأ بتيك توك، وتليها سناب شات وميتا وجوجل.",
    featuresTitle: "ماذا تقدّم غليو",
    features: [
      {
        heading: "ربط حسابات الإعلانات",
        paragraphs: ["يربط صاحب الحساب الإعلاني حسابه بموافقته عبر تسجيل الدخول الرسمي للمنصة. نبدأ بتيك توك، وتليها سناب شات وميتا وجوجل."],
      },
      {
        heading: "أرقام موثوقة قابلة للتتبع",
        paragraphs: ["كل رقم في التقرير مرتبط بالاستجابة الأصلية من المنصة، ونطابق المجاميع مع المنصة وننبّه إذا تجاوز الفرق 0.5%."],
      },
      {
        heading: "تقارير عربية لكل عميل",
        paragraphs: ["ملخصات مكتوبة بالعربية والإنجليزية. الذكاء الاصطناعي يكتب التعليق فقط، ولا يضيف أي رقم غير موجود في البيانات."],
      },
      {
        heading: "موافقات وسجل تدقيق",
        paragraphs: ["لا يُنفَّذ أي تغيير على الحملات دون موافقة صريحة، وكل إجراء يُسجَّل في سجل لا يمكن تعديله."],
      },
    ] as Section[],
    howTitle: "كيف تعمل",
    howSteps: [
      "اطلب عرضًا توضيحيًا، ونراجع معك حساباتك الإعلانية وإعداد التتبع.",
      "تربط حساباتك الإعلانية بموافقتك عبر صفحة المنصة الرسمية.",
      "يتابع فريقنا ووكلاء غليو حملاتك يوميًا ويقترحون التحسينات.",
      "توافق على أي تغيير قبل تنفيذه، وتستلم تقارير عربية واضحة.",
    ],
    trustTitle: "مبادئنا",
    trust: [
      "لا نحتفظ بأموال الإعلانات: تدفع للمنصة الإعلانية مباشرة من بطاقتك.",
      "رموز الوصول إلى المنصات تبقى على الخادم ولا تظهر في المتصفح.",
      "لا نبيع البيانات ولا نستخدمها لأي غرض غير تقديم الخدمة لك.",
      "لا ننشئ صورًا أو مقاطع فيديو.",
    ],
    aboutTitle: "من نحن",
    aboutText:
      "غليو وكالة تسويق رقمي سعودية. نبني منصة غليو لتسهيل تشغيل الإعلانات ومتابعتها وإعداد تقاريرها للشركات والوكالات السعودية.",
    contactTitle: "تواصل معنا",
    contactEmail: "البريد الإلكتروني",
    contactPhone: "الهاتف",
    contactCity: "المدينة",
    contactCr: "رقم السجل التجاري",
    footerRights: "جميع الحقوق محفوظة",
    updated: "آخر تحديث",
    demoKicker: "03 / عرض توضيحي",
    demoTitle: "اطلب عرضًا توضيحيًا",
    demoText: "راسلنا باسم شركتك وموقعك والمنصات الإعلانية التي تستخدمها وميزانيتك الشهرية التقريبية، وسنرتّب معك عرضًا لحساباتك.",
    demoCta: "راسلنا لطلب عرض",
    demoSubject: "طلب عرض توضيحي - غليو",
    demoBody: "الشركة:\nالموقع الإلكتروني:\nالمنصات الإعلانية:\nالميزانية الشهرية التقريبية:\n",
    privacyTitle: "سياسة الخصوصية",
    privacyIntro:
      "توضح هذه السياسة كيف تجمع {tradeName} البيانات وتستخدمها وتحميها عند استخدام موقع {domain} ومنصة غليو، وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية.",
    privacy: [
      {
        heading: "البيانات التي نجمعها",
        paragraphs: ["نجمع فقط ما نحتاجه لتقديم الخدمة:"],
        bullets: [
          "بيانات الحساب: البريد الإلكتروني وكلمة المرور (مشفّرة لدى مزوّد المصادقة).",
          "بيانات مساحة العمل: أسماء العملاء وأسماء أعضاء الفريق وصلاحياتهم.",
          "بيانات المنصات الإعلانية التي تربطها بموافقتك: معرّف الحساب الإعلاني واسمه وعملته، وأرقام أداء الحملات (الإنفاق، الظهور، النقرات، التحويلات) وأسماء الحملات.",
          "سجل تدقيق بالإجراءات المهمة داخل المنصة (مثل إنشاء تقرير أو عرض لوحة عميل).",
          "ما ترسله إلينا بالبريد الإلكتروني، مثل طلب عرض توضيحي (الاسم، الشركة، الموقع، بيانات التواصل).",
        ],
      },
      {
        heading: "بيانات تيك توك والمنصات الإعلانية",
        paragraphs: [
          "عند ربط حساب إعلاني (مثل تيك توك للأعمال)، تمنحنا المنصة رمز وصول بموافقتك. نستخدم هذا الرمز فقط لقراءة بيانات الحسابات الإعلانية التي اخترتها، ولتنفيذ التغييرات التي توافق عليها صراحة داخل غليو.",
          "نحفظ الاستجابات الأصلية من المنصة كما هي لإثبات مصدر كل رقم في التقارير. لا نبيع هذه البيانات ولا نشاركها مع معلنين آخرين، ولا نستخدمها لتدريب نماذج الذكاء الاصطناعي.",
          "يمكنك إلغاء الربط في أي وقت من داخل غليو أو من إعدادات المنصة الإعلانية، وعندها نتوقف عن جلب البيانات.",
        ],
      },
      {
        heading: "كيف نستخدم البيانات",
        paragraphs: ["نستخدم البيانات لعرض الأداء وإعداد التقارير ومطابقتها مع المنصة، وإرسال التنبيهات والتقارير التي تطلبها، وحماية الحسابات ومنع إساءة الاستخدام، والوفاء بالالتزامات النظامية."],
      },
      {
        heading: "الذكاء الاصطناعي",
        paragraphs: [
          "لكتابة ملخص التقرير قد نرسل إلى مزوّد الذكاء الاصطناعي (Anthropic) الأرقام الإجمالية للفترة فقط، دون أسماء العملاء أو الحسابات أو البيانات الأصلية أو رموز الوصول. يتحقق النظام من أن كل رقم في الملخص مطابق للأرقام الأصلية.",
        ],
      },
      {
        heading: "مزوّدو الخدمة",
        paragraphs: ["نعتمد على مزوّدين موثوقين لتشغيل الخدمة، ويعالجون البيانات نيابة عنا فقط:"],
        bullets: [
          "Supabase: قاعدة البيانات والمصادقة (خوادم في فرانكفورت، الاتحاد الأوروبي، خلال المرحلة الحالية).",
          "Vercel: استضافة الموقع والمنصة.",
          "Cloudflare: خدمة أسماء النطاقات.",
          "Google Workspace: البريد الإلكتروني.",
          "Anthropic: كتابة ملخصات التقارير (أرقام إجمالية فقط).",
        ],
      },
      {
        heading: "مدة الاحتفاظ والحذف",
        paragraphs: [
          "نحتفظ بالبيانات ما دام حسابك فعّالًا أو حسب ما يلزم نظامًا. عند حذف حساب إعلاني أو مساحة عمل تُحذف البيانات المتزامنة المرتبطة به، ويُحتفظ بسجل التدقيق لأغراض الأمان والامتثال.",
        ],
      },
      {
        heading: "حقوقك",
        paragraphs: ["يحق لك طلب الاطلاع على بياناتك أو تصحيحها أو حذفها، أو سحب موافقتك على ربط أي حساب إعلاني. راسلنا على {email} وسنرد خلال المدة النظامية."],
      },
      {
        heading: "الأمان",
        paragraphs: ["تُعزل بيانات كل مساحة عمل على مستوى قاعدة البيانات، وتبقى رموز الوصول على الخادم فقط، وتُنقل البيانات عبر اتصال مشفّر."],
      },
      {
        heading: "التواصل",
        paragraphs: ["لأي سؤال عن الخصوصية: {email}."],
      },
    ] as Section[],
    termsTitle: "الشروط والأحكام",
    termsIntro:
      "تنظّم هذه الشروط استخدامك لموقع {domain} ومنصة غليو المقدَّمة من {tradeName}. باستخدامك الخدمة فإنك توافق على هذه الشروط.",
    terms: [
      {
        heading: "الخدمة",
        paragraphs: ["غليو أداة لعرض أداء الإعلانات الرقمية وإعداد التقارير واقتراح التحسينات وتنفيذ ما توافق عليه منها. الخدمة في مرحلة الإطلاق الأولى وقد تتغير ميزاتها.",
          "تقدّم غليو أيضًا خدمات إدارة الإعلانات وإعداد التتبع وتحسين الظهور في محركات البحث، بموجب اتفاق مستقل مع كل عميل."],
      },
      {
        heading: "الحساب",
        paragraphs: ["أنت مسؤول عن صحة بيانات حسابك وعن الحفاظ على سرية كلمة المرور، وعن الإجراءات التي تتم من خلال حسابك."],
      },
      {
        heading: "الحسابات الإعلانية والتفويض",
        paragraphs: [
          "تربط فقط الحسابات الإعلانية التي تملكها أو لديك تفويض نظامي بإدارتها. إذا كنت وكالة، فأنت مسؤول عن الحصول على موافقة عملائك.",
          "يظل استخدامك للمنصات الإعلانية خاضعًا لشروطها وسياساتها الإعلانية.",
        ],
      },
      {
        heading: "الإنفاق الإعلاني",
        paragraphs: ["لا تحتفظ غليو بأي أموال إعلانية. تدفع للمنصة الإعلانية مباشرة، وأنت من يحدد الميزانيات. لا يُنفَّذ أي تغيير على الحملات أو الميزانيات دون موافقتك."],
      },
      {
        heading: "التقارير والذكاء الاصطناعي",
        paragraphs: ["الأرقام مصدرها المنصات الإعلانية، وقد تتأخر أو تتغير لاحقًا من جهة المنصة. الملخصات والاقتراحات للمساعدة فقط، والقرار النهائي لك."],
      },
      {
        heading: "الاستخدام المقبول",
        paragraphs: ["يُمنع استخدام الخدمة لأي نشاط مخالف للأنظمة، أو لمحاولة الوصول إلى بيانات الآخرين، أو للتأثير على عمل الخدمة."],
      },
      {
        heading: "حدود المسؤولية",
        paragraphs: ["تُقدَّم الخدمة \"كما هي\" في حدود ما يسمح به النظام. لا نتحمل مسؤولية نتائج الحملات الإعلانية أو قرارات المنصات الإعلانية."],
      },
      {
        heading: "الإيقاف والإنهاء",
        paragraphs: ["يمكنك التوقف عن استخدام الخدمة وطلب حذف بياناتك في أي وقت. يحق لنا إيقاف الحسابات التي تخالف هذه الشروط."],
      },
      {
        heading: "النظام المطبّق",
        paragraphs: ["تخضع هذه الشروط لأنظمة المملكة العربية السعودية."],
      },
      {
        heading: "التواصل",
        paragraphs: ["لأي سؤال عن هذه الشروط: {email}."],
      },
    ] as Section[],
  },
  en: {
    navHome: "Home",
    navServices: "Services",
    navPlatform: "Platform",
    navDemo: "Ask for a demo",
    navPrivacy: "Privacy policy",
    navTerms: "Terms of service",
    switchLang: "العربية",
    signIn: "Sign in",
    eyebrow: "Ad operations · Saudi Arabia",
    heroTitle1: "You don't need marketing.",
    heroTitle2a: "You need ",
    heroTitle2b: "results.",
    heroText:
      "GLIO combines a team of ad operators with the Glio platform: AI agents that watch your campaigns every day, numbers reconciled with the ad platforms, and clear Arabic reports. You approve, we execute.",
    heroCta: "Ask for a demo",
    heroSecondary: "See our services",
    platformsTitle: "Working across",
    servicesKicker: "01 / Services",
    servicesTitle: "Three services, one team.",
    servicesIntro: "We work as your full marketing team: we wire your data, run your ads, and make sure customers find you in search. As a one-time setup project, a monthly retainer, or both.",
    services: [
      {
        heading: "Paid ads management",
        paragraphs: ["Daily campaign management across Meta, Google, TikTok and Snapchat: strategy, bidding, retargeting and audience segmentation. Run by an operator who reads your sales numbers, helped by Glio's agents, and no budget change happens without your approval."],
        bullets: ["Meta", "Google", "TikTok", "Snapchat"],
      },
      {
        heading: "Tracking + data setup",
        paragraphs: ["Your analytics and pixel stack wired before the first ad runs: GA4, Google Tag Manager, Meta, TikTok and Snap pixels, server-side tagging, UTM standards, Search Console and Merchant Center."],
        bullets: ["GA4", "GTM", "Pixels", "Server-side"],
      },
      {
        heading: "SEO + visibility",
        paragraphs: ["Keyword strategy implemented across your pages and products, structured data, Search Console and Merchant Center set up, and local visibility through Google Maps and your Business Profile."],
        bullets: ["Keywords", "Schema", "Local SEO", "Maps"],
      },
    ] as Section[],
    platformKicker: "02 / Platform",
    platformTitle: "The Glio platform",
    platformIntro: "The platform our team works on, and that our clients can use: TikTok first, followed by Snapchat, Meta and Google.",
    featuresTitle: "What Glio does",
    features: [
      {
        heading: "Connect ad accounts",
        paragraphs: ["Account owners connect their ad accounts with their consent through the platform's official sign-in. We start with TikTok, followed by Snapchat, Meta and Google."],
      },
      {
        heading: "Numbers you can trace",
        paragraphs: ["Every figure in a report links to the platform's original response. We reconcile totals against the platform and flag any difference above 0.5%."],
      },
      {
        heading: "Arabic reports for every client",
        paragraphs: ["Summaries written in Arabic and English. AI writes the commentary only and never adds a number that isn't in the data."],
      },
      {
        heading: "Approvals and audit log",
        paragraphs: ["No change is made to campaigns without explicit approval, and every action is recorded in a log that cannot be edited."],
      },
    ] as Section[],
    howTitle: "How it works",
    howSteps: [
      "Ask for a demo, and we review your ad accounts and tracking with you.",
      "Connect your ad accounts with your consent through each platform's official page.",
      "Our team and Glio's agents watch your campaigns daily and suggest improvements.",
      "You approve any change before it runs, and receive clear Arabic reports.",
    ],
    trustTitle: "Our principles",
    trust: [
      "We never hold ad money: you pay the ad platform directly from your own card.",
      "Platform access tokens stay on the server and never reach the browser.",
      "We don't sell data or use it for anything other than providing the service to you.",
      "We don't generate images or videos.",
    ],
    aboutTitle: "About us",
    aboutText:
      "Glio is a Saudi digital marketing agency. We are building the Glio platform to make running, monitoring and reporting on ads easier for Saudi businesses and agencies.",
    contactTitle: "Contact us",
    contactEmail: "Email",
    contactPhone: "Phone",
    contactCity: "City",
    contactCr: "Commercial Registration No.",
    footerRights: "All rights reserved",
    updated: "Last updated",
    demoKicker: "03 / Demo",
    demoTitle: "Ask for a demo",
    demoText: "Email us your company name, website, the ad platforms you use and your approximate monthly budget, and we'll set up a demo on your accounts.",
    demoCta: "Email us for a demo",
    demoSubject: "Demo request - GLIO",
    demoBody: "Company:\nWebsite:\nAd platforms:\nApproximate monthly budget:\n",
    privacyTitle: "Privacy policy",
    privacyIntro:
      "This policy explains how {tradeName} collects, uses and protects data when you use {domain} and the Glio platform, in line with the Saudi Personal Data Protection Law (PDPL).",
    privacy: [
      {
        heading: "Data we collect",
        paragraphs: ["We collect only what we need to provide the service:"],
        bullets: [
          "Account data: your email address and password (hashed by our authentication provider).",
          "Workspace data: client names, team members' names and their roles.",
          "Ad platform data you connect with your consent: the ad account ID, name and currency, campaign names, and campaign performance figures (spend, impressions, clicks, conversions).",
          "An audit log of important actions in the platform (such as creating a report or viewing a client dashboard).",
          "What you send us by email, such as a demo request (name, company, website, contact details).",
        ],
      },
      {
        heading: "TikTok and other ad platform data",
        paragraphs: [
          "When you connect an ad account (for example TikTok for Business), the platform grants us an access token with your consent. We use it only to read data from the ad accounts you selected, and to make changes you explicitly approve inside Glio.",
          "We store the platform's original responses unchanged to prove where every reported figure comes from. We do not sell this data, share it with other advertisers, or use it to train AI models.",
          "You can disconnect at any time from inside Glio or from the ad platform's settings, after which we stop fetching data.",
        ],
      },
      {
        heading: "How we use data",
        paragraphs: ["We use data to show performance, prepare and reconcile reports, send the alerts and reports you ask for, secure accounts and prevent abuse, and meet legal obligations."],
      },
      {
        heading: "Artificial intelligence",
        paragraphs: [
          "To write a report summary we may send our AI provider (Anthropic) the aggregated figures for the period only, never client or account names, raw platform data or access tokens. The system checks that every number in the summary matches the original figures.",
        ],
      },
      {
        heading: "Service providers",
        paragraphs: ["We rely on trusted providers to run the service; they process data only on our behalf:"],
        bullets: [
          "Supabase: database and authentication (servers in Frankfurt, EU, during the current phase).",
          "Vercel: hosting for the website and platform.",
          "Cloudflare: domain name service.",
          "Google Workspace: email.",
          "Anthropic: writing report summaries (aggregated figures only).",
        ],
      },
      {
        heading: "Retention and deletion",
        paragraphs: [
          "We keep data while your account is active or as required by law. Deleting an ad account or workspace deletes the synced data linked to it; the audit log is kept for security and compliance.",
        ],
      },
      {
        heading: "Your rights",
        paragraphs: ["You can ask to access, correct or delete your data, or withdraw consent for any connected ad account. Email {email} and we will respond within the legal time limit."],
      },
      {
        heading: "Security",
        paragraphs: ["Each workspace's data is isolated at the database level, access tokens stay server-side only, and data travels over encrypted connections."],
      },
      {
        heading: "Contact",
        paragraphs: ["For any privacy question: {email}."],
      },
    ] as Section[],
    termsTitle: "Terms of service",
    termsIntro:
      "These terms govern your use of {domain} and the Glio platform provided by {tradeName}. By using the service you agree to these terms.",
    terms: [
      {
        heading: "The service",
        paragraphs: ["Glio is a tool to view digital advertising performance, prepare reports, suggest improvements and carry out the ones you approve. The service is in its first launch phase and its features may change.",
          "Glio also provides managed advertising, tracking setup and SEO services under a separate agreement with each client."],
      },
      {
        heading: "Your account",
        paragraphs: ["You are responsible for the accuracy of your account details, for keeping your password confidential, and for actions taken through your account."],
      },
      {
        heading: "Ad accounts and authorisation",
        paragraphs: [
          "Connect only ad accounts you own or are legally authorised to manage. If you are an agency, you are responsible for obtaining your clients' consent.",
          "Your use of ad platforms remains subject to their own terms and advertising policies.",
        ],
      },
      {
        heading: "Ad spend",
        paragraphs: ["Glio never holds advertising money. You pay the ad platform directly and you set the budgets. No change to campaigns or budgets is made without your approval."],
      },
      {
        heading: "Reports and AI",
        paragraphs: ["Figures come from the ad platforms and may be delayed or later revised by the platform. Summaries and suggestions are assistance only; the final decision is yours."],
      },
      {
        heading: "Acceptable use",
        paragraphs: ["You may not use the service for any unlawful activity, to try to access other people's data, or to interfere with the service."],
      },
      {
        heading: "Limitation of liability",
        paragraphs: ["The service is provided \"as is\" to the extent permitted by law. We are not responsible for the results of ad campaigns or for decisions made by ad platforms."],
      },
      {
        heading: "Suspension and termination",
        paragraphs: ["You can stop using the service and ask us to delete your data at any time. We may suspend accounts that breach these terms."],
      },
      {
        heading: "Governing law",
        paragraphs: ["These terms are governed by the laws of the Kingdom of Saudi Arabia."],
      },
      {
        heading: "Contact",
        paragraphs: ["For any question about these terms: {email}."],
      },
    ] as Section[],
  },
};

export type SiteText = (typeof site)["en"];

/** Fill {legalName}, {tradeName}, {domain}, {email} and {country} for the given language. */
export function fill(text: string, lang: "ar" | "en"): string {
  const values: Record<string, string> = {
    legalName: lang === "ar" ? COMPANY.legalNameAr : COMPANY.legalNameEn,
    tradeName: lang === "ar" ? COMPANY.tradeNameAr : COMPANY.tradeNameEn,
    domain: COMPANY.domain,
    email: COMPANY.email,
    country: COMPANY.country[lang],
  };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}
