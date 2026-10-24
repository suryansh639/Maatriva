/**
 * Field-area i18n (Requirements 23.1, 32.1–32.5; design §16 "i18n").
 *
 * - `en` is the source dictionary. `MessageKey` is derived from it, and `hi` is
 *   typed `Record<MessageKey, string>`, so the compiler rejects a Hindi
 *   dictionary with a missing or an extra key.
 * - Namespaces: `field.*`, `sync.*`, `risk.*`, `flag.*`, `action.*`, `validation.*`.
 * - English strings that the README, the E2E script or the backend rely on are
 *   kept verbatim (e.g. "Simulate offline", "{n} pending", "Yes, this is {name}").
 * - `action.*` English labels must equal `backend/app/notifications.py`
 *   `ACTION_LABELS_EN`.
 * - Flag labels are shown together with the server's English reason (Req 32.2).
 * - The doctor area is English only and does not use this module (Req 32.6).
 */

export type Lang = 'en' | 'hi';

export const LANGS: readonly Lang[] = ['en', 'hi'];
export const DEFAULT_LANG: Lang = 'en';
export const LANG_STORAGE_KEY = 'maatriva.lang';

/** Native names, used by the language toggle. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { en: 'English', hi: 'हिन्दी' };

export const ACTION_TYPES = [
  'HOME_VISIT_48H',
  'REFER_PHC',
  'IFA_PER_PROTOCOL',
  'REPEAT_HB',
  'BP_RECHECK',
  'ENSURE_THR',
  'DIET_COUNSEL',
  'OTHER',
] as const;
export type ActionTypeCode = (typeof ACTION_TYPES)[number];

export const FLAG_CODES = [
  'HB_SEVERE',
  'HB_MODERATE',
  'HB_MILD',
  'BP_SEVERE',
  'BP_HIGH',
  'WEIGHT_LOSS',
  'WEIGHT_STATIC',
  'WEIGHT_GAIN_LOW',
  'BMI_LOW',
  'LATE_REG',
  'VISIT_OVERDUE',
] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

export const RISK_LEVELS = ['RED', 'AMBER', 'GREEN'] as const;
export type RiskLevelCode = (typeof RISK_LEVELS)[number];

/** Rejection codes the sync push can return (design §7). */
export const SYNC_ERROR_CODES = [
  'UNKNOWN_ENTITY',
  'VALIDATION_ERROR',
  'OUT_OF_SCOPE',
  'MOTHER_NOT_FOUND',
  'CONFLICT',
  'MOTHER_INACTIVE',
  'TASK_NOT_FOUND',
  'TASK_CANCELLED',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

// --------------------------------------------------------------------------- English

const en = {
  // App shell and common
  'field.app.name': 'Maatriva',
  'field.app.synthetic': 'Synthetic data only – no real personal data',
  'field.common.save': 'Save',
  'field.common.cancel': 'Cancel',
  'field.common.back': 'Back',
  'field.common.close': 'Close',
  'field.common.yes': 'Yes',
  'field.common.no': 'No',
  'field.common.optional': '(optional)',
  'field.common.loading': 'Loading…',
  'field.common.tryAgain': 'Try again',
  'field.common.kg': 'kg',
  'field.common.demoTag': 'Demo',
  'field.common.bplTag': 'BPL',
  'field.common.pendingMarker': 'Not synced yet',
  'field.common.logout': 'Log out',
  'field.common.logoutPending':
    '{n} changes are not synced yet. They stay saved on this phone. Log out anyway?',

  // Header controls
  'field.lang.label': 'Language',
  'field.lang.switchTo': 'Switch language to {lang}',
  'field.offline.label': 'Simulate offline',
  'field.offline.hint': 'Pretend there is no network, to show offline work',

  // Bottom navigation
  'field.nav.label': 'Main navigation',
  'field.nav.mothers': 'Mothers',
  'field.nav.register': 'Register',
  'field.nav.tasks': 'Tasks',
  'field.nav.openTasks': '{n} open tasks',

  // Login
  'field.login.title': 'Sign in',
  'field.login.username': 'Username',
  'field.login.password': 'Password',
  'field.login.submit': 'Sign in',
  'field.login.signingIn': 'Signing in…',
  'field.login.invalid': 'Invalid username or password',
  'field.login.offlineFirst': 'Internet needed for first sign-in',
  'field.login.failed': 'Could not sign in – try again',
  'field.login.expired': 'Your sign-in has expired. Sign in again to sync. Work saved on this phone is kept.',
  'field.login.continueOffline': 'Continue without signing in',

  // Mothers list
  'field.mothers.title': 'Mothers',
  'field.mothers.searchLabel': 'Search by name, guardian, village or code',
  'field.mothers.empty': 'No mothers yet. Register a mother or sync.',
  'field.mothers.noResults': 'No mothers match "{q}"',
  'field.mothers.count': '{n} mothers',
  'field.mothers.guardian': 'Guardian: {name}',
  'field.mothers.ga': 'GA {ga}',
  'field.mothers.open': 'Open {name}',

  // Register mother
  'field.register.title': 'Register mother',
  'field.register.fullName': 'Name',
  'field.register.age': 'Age (years)',
  'field.register.guardianName': 'Husband or guardian name',
  'field.register.village': 'Village',
  'field.register.villagePlaceholder': 'Choose village',
  'field.register.phone': 'Phone (optional)',
  'field.register.lmp': 'Last menstrual period (LMP)',
  'field.register.gaPreview': 'Pregnancy (GA): {ga}',
  'field.register.eddPreview': 'Expected delivery (EDD): {edd}',
  'field.register.bpl': 'BPL household',
  'field.register.height': 'Height (cm)',
  'field.register.firstWeight': 'First weight (kg)',
  'field.register.weightFromScale': 'Weight from scale: {w} kg',
  'field.register.save': 'Save mother',
  'field.register.saved': 'Saved on this phone. It will sync when online.',

  // Mother detail
  'field.detail.title': 'Mother details',
  'field.detail.profile': 'Profile',
  'field.detail.age': 'Age {n}',
  'field.detail.guardian': 'Guardian',
  'field.detail.village': 'Village',
  'field.detail.phone': 'Phone',
  'field.detail.code': 'Code',
  'field.detail.ga': 'Pregnancy (GA)',
  'field.detail.edd': 'Expected delivery (EDD)',
  'field.detail.height': 'Height',
  'field.detail.status': 'Status',
  'field.detail.statusActive': 'Pregnant',
  'field.detail.statusDelivered': 'Delivered',
  'field.detail.flags': 'Risk reasons',
  'field.detail.noFlags': 'No risk flags',
  'field.detail.visits': 'Visits',
  'field.detail.noVisits': 'No visits yet',
  'field.detail.visitWeight': 'Weight {w} kg',
  'field.detail.visitHb': 'Hb {hb} g/dL',
  'field.detail.visitBp': 'BP {s}/{d}',
  'field.detail.tasks': 'Tasks from doctor',
  'field.detail.noTasks': 'No tasks',
  'field.detail.newVisit': 'New visit',
  'field.detail.weightChart': 'Weight chart',
  'field.detail.chartEmpty': 'At least 2 weights are needed for the chart',
  'field.detail.notFound': 'Mother not found on this phone',

  // New visit
  'field.visit.title': 'New visit for {name}',
  'field.visit.date': 'Visit date',
  'field.visit.weight': 'Weight',
  'field.visit.useBle': 'Use Bluetooth scale',
  'field.visit.useSimulated': 'Simulated scale',
  'field.visit.typeManually': 'Type manually',
  'field.visit.weightKg': 'Weight (kg)',
  'field.visit.weightFromScale': 'Weight from scale: {w} kg',
  'field.visit.changeWeight': 'Change weight',
  'field.visit.hb': 'Hb (g/dL)',
  'field.visit.hbSource': 'Hb source',
  'field.visit.hbSourceManual': 'Manual',
  'field.visit.hbSourceDevice': 'Device (entered from meter)',
  'field.visit.bpSystolic': 'BP systolic (upper)',
  'field.visit.bpDiastolic': 'BP diastolic (lower)',
  'field.visit.bpSource': 'BP source',
  'field.visit.bpSourceManual': 'Manual',
  'field.visit.bpSourceDevice': 'Device',
  'field.visit.ifa': 'IFA tablets given',
  'field.visit.calcium': 'Calcium tablets given',
  'field.visit.thr': 'Take-home ration (THR) received',
  'field.visit.notes': 'Notes',
  'field.visit.save': 'Save visit',
  'field.visit.saved': 'Visit saved on this phone.',
  'field.visit.carried': 'Readings moved here from another mother. Check them, then save.',

  // Numeric keypad
  'field.keypad.label': 'Number keypad',
  'field.keypad.decimal': 'Decimal point',
  'field.keypad.backspace': 'Delete last digit',
  'field.keypad.clear': 'Clear',

  // Mother confirmation
  'field.confirm.title': 'Is this the right mother?',
  'field.confirm.body': 'Check before saving the scale reading.',
  'field.confirm.yes': 'Yes, this is {name}',
  'field.confirm.no': 'No, wrong mother',
  'field.confirm.chooseAnother': 'Choose another mother',
  'field.confirm.pickerTitle': 'Choose the mother for this reading',
  'field.confirm.pickerEmpty': 'No other mothers on this phone',
  'field.confirm.notSaved': 'Not saved. Check the mother, or choose another mother for this reading.',
  'field.confirm.code': 'Code {code}',
  'field.confirm.ga': 'GA {ga}',

  // Scales (simulated and Bluetooth)
  'field.scale.simTitle': 'Simulated scale',
  'field.scale.targetWeight': 'Target weight (kg)',
  'field.scale.jitter': 'Add ±0.2 kg jitter',
  'field.scale.demoPreset': 'Demo preset (56.6 kg)',
  'field.scale.stepOn': 'Step on scale',
  'field.scale.stabilizing': 'Stabilizing…',
  'field.scale.rawHex': 'Raw bytes (hex)',
  'field.scale.parsedKg': 'Weight: {w} kg',
  'field.scale.useReading': 'Use this reading',
  'field.scale.implausible': 'Implausible reading – weigh again',
  'field.scale.parseError': 'Could not read the scale data ({code})',
  'field.ble.title': 'Bluetooth scale',
  'field.ble.connect': 'Connect scale',
  'field.ble.connecting': 'Connecting…',
  'field.ble.waiting': 'Step on the scale now',
  'field.ble.readings': 'Readings',
  'field.ble.stop': 'Stop',
  'field.ble.unsupported':
    'Bluetooth needs Chrome on Android/desktop over HTTPS or localhost – use Simulated scale',
  'field.ble.noReading': 'No reading received – step on the scale again',
  'field.ble.connectFailed': 'Could not connect – try again',
  'field.ble.notStandard': "This scale doesn't use the standard Bluetooth weight service",
  'field.ble.failed': 'Bluetooth error – try again',

  // Tasks inbox
  'field.tasks.title': 'Tasks',
  'field.tasks.open': 'Open tasks',
  'field.tasks.done': 'Done tasks ({n})',
  'field.tasks.empty': 'No tasks from the doctor',
  'field.tasks.forMother': 'For {name}',
  'field.tasks.issuedBy': 'From {name}',
  'field.tasks.due': 'Due {date}',
  'field.tasks.overdue': 'Overdue',
  'field.tasks.markDone': 'Mark done',
  'field.tasks.note': 'Note (optional)',
  'field.tasks.confirmDone': 'Save as done',
  'field.tasks.doneOn': 'Done {date}',
  'field.tasks.cancelled': 'Cancelled',

  // Sync errors screen
  'field.syncErrors.title': 'Sync errors',
  'field.syncErrors.intro': 'These changes were not accepted by the server.',
  'field.syncErrors.empty': 'No sync errors',
  'field.syncErrors.code': 'Code: {code}',
  'field.syncErrors.remove': 'Remove',

  // Generic errors
  'field.error.generic': 'Something went wrong – try again',
  'field.error.saveFailed': 'Could not save on this phone – try again',
  'field.error.notFound': 'Page not found',

  // Sync badge
  'sync.badge.offline': 'Offline',
  'sync.badge.offlineSimulated': 'Offline (simulated)',
  'sync.badge.syncing': 'Syncing…',
  'sync.badge.pending': '{n} pending',
  'sync.badge.synced': 'Synced {time}',
  'sync.badge.neverSynced': 'Not synced yet',
  'sync.badge.error': 'Sync error – will retry',
  'sync.badge.signIn': 'Sign in to sync',
  'sync.badge.forbidden': 'Not allowed',
  'sync.badge.errors': '{n} sync errors',
  'sync.badge.errorsOne': '1 sync error',
  'sync.now': 'Sync now',
  'sync.lastSync': 'Last sync {time}',
  'sync.entity.mother': 'Mother',
  'sync.entity.visit': 'Visit',
  'sync.entity.task': 'Task',
  'sync.code.UNKNOWN_ENTITY': 'Unknown change type',
  'sync.code.VALIDATION_ERROR': 'Invalid data',
  'sync.code.OUT_OF_SCOPE': 'Not in your villages',
  'sync.code.MOTHER_NOT_FOUND': 'Mother not found on the server',
  'sync.code.CONFLICT': 'Conflicting record',
  'sync.code.MOTHER_INACTIVE': 'Mother has already delivered',
  'sync.code.TASK_NOT_FOUND': 'Task not found',
  'sync.code.TASK_CANCELLED': 'Task was cancelled',

  // Risk levels
  'risk.RED': 'RED – High',
  'risk.AMBER': 'AMBER – Watch',
  'risk.GREEN': 'GREEN – Routine',
  'risk.pending': 'Risk: pending sync',

  // Flag codes (shown with the server's English reason)
  'flag.HB_SEVERE': 'Severe anaemia',
  'flag.HB_MODERATE': 'Moderate anaemia',
  'flag.HB_MILD': 'Mild anaemia',
  'flag.BP_SEVERE': 'Very high BP',
  'flag.BP_HIGH': 'High BP',
  'flag.WEIGHT_LOSS': 'Weight loss',
  'flag.WEIGHT_STATIC': 'No weight gain',
  'flag.WEIGHT_GAIN_LOW': 'Low weight gain',
  'flag.BMI_LOW': 'Low BMI',
  'flag.LATE_REG': 'Late registration',
  'flag.VISIT_OVERDUE': 'Visit overdue',

  // Action presets (must equal backend ACTION_LABELS_EN)
  'action.HOME_VISIT_48H': 'Home visit within 48 hours',
  'action.REFER_PHC': 'Refer to PHC for evaluation',
  'action.IFA_PER_PROTOCOL': 'Give/adjust IFA as per protocol',
  'action.REPEAT_HB': 'Repeat Hb test',
  'action.BP_RECHECK': 'Recheck BP',
  'action.ENSURE_THR': 'Ensure take-home ration',
  'action.DIET_COUNSEL': 'Diet counselling',
  'action.OTHER': 'Other action',

  // Validation (mirrors Requirement 11)
  'validation.required': 'Required',
  'validation.number': 'Enter a number',
  'validation.integer': 'Enter a whole number',
  'validation.date': 'Enter a valid date',
  'validation.nameLength': 'Enter 1 to 100 characters',
  'validation.ageRange': 'Age must be 14 to 55 years',
  'validation.phone': 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9',
  'validation.village': 'Choose a village',
  'validation.lmpFuture': 'LMP cannot be after today',
  'validation.lmpRange': 'LMP must be on or before registration and at most 44 weeks earlier',
  'validation.heightRange': 'Height must be 120 to 200 cm',
  'validation.weightRange': 'Weight must be 25 to 150 kg',
  'validation.weightSource': 'Choose how the weight was measured',
  'validation.hbRange': 'Hb must be 3.0 to 20.0 g/dL',
  'validation.hbDecimals': 'Use at most 1 decimal place',
  'validation.hbSource': 'Choose the Hb source',
  'validation.bpBoth': 'Enter both BP values',
  'validation.bpSystolicRange': 'Systolic must be 60 to 260',
  'validation.bpDiastolicRange': 'Diastolic must be 30 to 160',
  'validation.bpOrder': 'Systolic must be higher than diastolic',
  'validation.bpSource': 'Choose the BP source',
  'validation.tabletsRange': 'Tablets must be 0 to 180',
  'validation.notesLength': 'Notes can be at most 500 characters',
  'validation.doneNoteLength': 'Note can be at most 300 characters',
  'validation.visitBeforeLmp': 'Visit date cannot be before LMP',
  'validation.visitFuture': 'Visit date cannot be later than tomorrow',
} as const;

/** Every translatable key. Derived from the English dictionary. */
export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

// --------------------------------------------------------------------------- Hindi

// Typed as Record<MessageKey, string>: a missing or extra key is a compile error.
const hi: Record<MessageKey, string> = {
  'field.app.name': 'मातृवा',
  'field.app.synthetic': 'केवल नकली (डेमो) डेटा – कोई असली निजी जानकारी नहीं',
  'field.common.save': 'सेव करें',
  'field.common.cancel': 'रद्द करें',
  'field.common.back': 'वापस',
  'field.common.close': 'बंद करें',
  'field.common.yes': 'हाँ',
  'field.common.no': 'नहीं',
  'field.common.optional': '(वैकल्पिक)',
  'field.common.loading': 'लोड हो रहा है…',
  'field.common.tryAgain': 'फिर से कोशिश करें',
  'field.common.kg': 'किलो',
  'field.common.demoTag': 'डेमो',
  'field.common.bplTag': 'बीपीएल',
  'field.common.pendingMarker': 'अभी सिंक नहीं हुआ',
  'field.common.logout': 'लॉग आउट',
  'field.common.logoutPending':
    '{n} बदलाव अभी सिंक नहीं हुए हैं। ये इस फ़ोन में सेव रहेंगे। फिर भी लॉग आउट करें?',

  'field.lang.label': 'भाषा',
  'field.lang.switchTo': 'भाषा बदलकर {lang} करें',
  'field.offline.label': 'ऑफ़लाइन अभ्यास',
  'field.offline.hint': 'नेटवर्क न होने का अभ्यास करें, ताकि ऑफ़लाइन काम दिखाया जा सके',

  'field.nav.label': 'मुख्य मेनू',
  'field.nav.mothers': 'माताएँ',
  'field.nav.register': 'पंजीकरण',
  'field.nav.tasks': 'काम',
  'field.nav.openTasks': '{n} काम बाकी',

  'field.login.title': 'साइन इन करें',
  'field.login.username': 'यूज़रनेम',
  'field.login.password': 'पासवर्ड',
  'field.login.submit': 'साइन इन करें',
  'field.login.signingIn': 'साइन इन हो रहा है…',
  'field.login.invalid': 'यूज़रनेम या पासवर्ड गलत है',
  'field.login.offlineFirst': 'पहली बार साइन इन के लिए इंटरनेट चाहिए',
  'field.login.failed': 'साइन इन नहीं हो सका – फिर से कोशिश करें',
  'field.login.expired': 'आपका साइन इन खत्म हो गया है। सिंक के लिए फिर से साइन इन करें। इस फ़ोन में सेव काम सुरक्षित रहेगा।',
  'field.login.continueOffline': 'साइन इन किए बिना जारी रखें',

  'field.mothers.title': 'माताएँ',
  'field.mothers.searchLabel': 'नाम, पति/अभिभावक, गाँव या कोड से खोजें',
  'field.mothers.empty': 'अभी कोई माँ दर्ज नहीं है। नई माँ का पंजीकरण करें या सिंक करें।',
  'field.mothers.noResults': '"{q}" से कोई माँ नहीं मिली',
  'field.mothers.count': '{n} माताएँ',
  'field.mothers.guardian': 'पति/अभिभावक: {name}',
  'field.mothers.ga': 'गर्भ अवधि {ga}',
  'field.mothers.open': '{name} को खोलें',

  'field.register.title': 'माँ का पंजीकरण',
  'field.register.fullName': 'नाम',
  'field.register.age': 'उम्र (साल)',
  'field.register.guardianName': 'पति या अभिभावक का नाम',
  'field.register.village': 'गाँव',
  'field.register.villagePlaceholder': 'गाँव चुनें',
  'field.register.phone': 'फ़ोन नंबर (वैकल्पिक)',
  'field.register.lmp': 'आख़िरी माहवारी की तारीख़ (LMP)',
  'field.register.gaPreview': 'गर्भ की अवधि (GA): {ga}',
  'field.register.eddPreview': 'प्रसव की संभावित तारीख़ (EDD): {edd}',
  'field.register.bpl': 'बीपीएल परिवार',
  'field.register.height': 'लंबाई (सेमी)',
  'field.register.firstWeight': 'पहला वज़न (किलो)',
  'field.register.weightFromScale': 'मशीन से वज़न: {w} किलो',
  'field.register.save': 'माँ का पंजीकरण सेव करें',
  'field.register.saved': 'इस फ़ोन में सेव हो गया। इंटरनेट मिलने पर सिंक होगा।',

  'field.detail.title': 'माँ की जानकारी',
  'field.detail.profile': 'प्रोफ़ाइल',
  'field.detail.age': 'उम्र {n}',
  'field.detail.guardian': 'पति/अभिभावक',
  'field.detail.village': 'गाँव',
  'field.detail.phone': 'फ़ोन',
  'field.detail.code': 'कोड',
  'field.detail.ga': 'गर्भ की अवधि (GA)',
  'field.detail.edd': 'प्रसव की संभावित तारीख़ (EDD)',
  'field.detail.height': 'लंबाई',
  'field.detail.status': 'स्थिति',
  'field.detail.statusActive': 'गर्भवती',
  'field.detail.statusDelivered': 'प्रसव हो गया',
  'field.detail.flags': 'जोखिम के कारण',
  'field.detail.noFlags': 'कोई जोखिम नहीं',
  'field.detail.visits': 'विज़िट',
  'field.detail.noVisits': 'अभी कोई विज़िट नहीं',
  'field.detail.visitWeight': 'वज़न {w} किलो',
  'field.detail.visitHb': 'Hb {hb} g/dL',
  'field.detail.visitBp': 'बीपी {s}/{d}',
  'field.detail.tasks': 'डॉक्टर के दिए काम',
  'field.detail.noTasks': 'कोई काम नहीं',
  'field.detail.newVisit': 'नई विज़िट',
  'field.detail.weightChart': 'वज़न का चार्ट',
  'field.detail.chartEmpty': 'चार्ट के लिए कम से कम 2 बार का वज़न चाहिए',
  'field.detail.notFound': 'यह माँ इस फ़ोन में नहीं मिली',

  'field.visit.title': '{name} की नई विज़िट',
  'field.visit.date': 'विज़िट की तारीख़',
  'field.visit.weight': 'वज़न',
  'field.visit.useBle': 'ब्लूटूथ वज़न मशीन से लें',
  'field.visit.useSimulated': 'डेमो वज़न मशीन',
  'field.visit.typeManually': 'ख़ुद लिखें',
  'field.visit.weightKg': 'वज़न (किलो)',
  'field.visit.weightFromScale': 'मशीन से वज़न: {w} किलो',
  'field.visit.changeWeight': 'वज़न बदलें',
  'field.visit.hb': 'हीमोग्लोबिन – Hb (g/dL)',
  'field.visit.hbSource': 'Hb कैसे लिया',
  'field.visit.hbSourceManual': 'हाथ से लिखा',
  'field.visit.hbSourceDevice': 'मशीन (मीटर से देखकर लिखा)',
  'field.visit.bpSystolic': 'बीपी ऊपर वाला (सिस्टोलिक)',
  'field.visit.bpDiastolic': 'बीपी नीचे वाला (डायस्टोलिक)',
  'field.visit.bpSource': 'बीपी कैसे लिया',
  'field.visit.bpSourceManual': 'हाथ से लिखा',
  'field.visit.bpSourceDevice': 'मशीन',
  'field.visit.ifa': 'आयरन (IFA) की गोलियाँ दीं',
  'field.visit.calcium': 'कैल्शियम की गोलियाँ दीं',
  'field.visit.thr': 'टेक-होम राशन (THR) मिला',
  'field.visit.notes': 'टिप्पणी',
  'field.visit.save': 'विज़िट सेव करें',
  'field.visit.saved': 'विज़िट इस फ़ोन में सेव हो गई।',
  'field.visit.carried': 'रीडिंग दूसरी माँ से यहाँ लाई गई है। जाँच करें, फिर सेव करें।',

  'field.keypad.label': 'नंबर कीपैड',
  'field.keypad.decimal': 'दशमलव',
  'field.keypad.backspace': 'आख़िरी अंक मिटाएँ',
  'field.keypad.clear': 'सब मिटाएँ',

  'field.confirm.title': 'क्या यह सही माँ है?',
  'field.confirm.body': 'मशीन की रीडिंग सेव करने से पहले जाँच लें।',
  'field.confirm.yes': 'हाँ, यह {name} है',
  'field.confirm.no': 'नहीं, यह दूसरी माँ है',
  'field.confirm.chooseAnother': 'दूसरी माँ चुनें',
  'field.confirm.pickerTitle': 'यह रीडिंग किस माँ की है, चुनें',
  'field.confirm.pickerEmpty': 'इस फ़ोन में कोई दूसरी माँ नहीं है',
  'field.confirm.notSaved': 'सेव नहीं हुआ। माँ की जाँच करें, या इस रीडिंग के लिए दूसरी माँ चुनें।',
  'field.confirm.code': 'कोड {code}',
  'field.confirm.ga': 'गर्भ अवधि {ga}',

  'field.scale.simTitle': 'डेमो वज़न मशीन',
  'field.scale.targetWeight': 'वज़न चुनें (किलो)',
  'field.scale.jitter': '±0.2 किलो का थोड़ा फ़र्क जोड़ें',
  'field.scale.demoPreset': 'डेमो वज़न (56.6 किलो)',
  'field.scale.stepOn': 'मशीन पर खड़े हों',
  'field.scale.stabilizing': 'वज़न स्थिर हो रहा है…',
  'field.scale.rawHex': 'मशीन का कच्चा डेटा (hex)',
  'field.scale.parsedKg': 'वज़न: {w} किलो',
  'field.scale.useReading': 'यह रीडिंग लें',
  'field.scale.implausible': 'रीडिंग सही नहीं लगती – दोबारा वज़न करें',
  'field.scale.parseError': 'मशीन का डेटा पढ़ा नहीं जा सका ({code})',
  'field.ble.title': 'ब्लूटूथ वज़न मशीन',
  'field.ble.connect': 'मशीन जोड़ें',
  'field.ble.connecting': 'जुड़ रहा है…',
  'field.ble.waiting': 'अब मशीन पर खड़े हों',
  'field.ble.readings': 'रीडिंग',
  'field.ble.stop': 'बंद करें',
  'field.ble.unsupported':
    'ब्लूटूथ के लिए Android या कंप्यूटर पर Chrome और HTTPS या localhost चाहिए – डेमो वज़न मशीन इस्तेमाल करें',
  'field.ble.noReading': 'कोई रीडिंग नहीं मिली – मशीन पर फिर से खड़े हों',
  'field.ble.connectFailed': 'मशीन से जुड़ नहीं सके – फिर से कोशिश करें',
  'field.ble.notStandard': 'यह मशीन सामान्य ब्लूटूथ वज़न सेवा का इस्तेमाल नहीं करती',
  'field.ble.failed': 'ब्लूटूथ में गड़बड़ी – फिर से कोशिश करें',

  'field.tasks.title': 'काम',
  'field.tasks.open': 'बाकी काम',
  'field.tasks.done': 'पूरे हुए काम ({n})',
  'field.tasks.empty': 'डॉक्टर से कोई काम नहीं मिला',
  'field.tasks.forMother': '{name} के लिए',
  'field.tasks.issuedBy': '{name} की ओर से',
  'field.tasks.due': 'आख़िरी तारीख़ {date}',
  'field.tasks.overdue': 'समय निकल गया',
  'field.tasks.markDone': 'पूरा हुआ',
  'field.tasks.note': 'टिप्पणी (वैकल्पिक)',
  'field.tasks.confirmDone': 'पूरा हुआ सेव करें',
  'field.tasks.doneOn': '{date} को पूरा हुआ',
  'field.tasks.cancelled': 'रद्द',

  'field.syncErrors.title': 'सिंक की गड़बड़ियाँ',
  'field.syncErrors.intro': 'सर्वर ने ये बदलाव स्वीकार नहीं किए।',
  'field.syncErrors.empty': 'सिंक में कोई गड़बड़ी नहीं',
  'field.syncErrors.code': 'कोड: {code}',
  'field.syncErrors.remove': 'हटाएँ',

  'field.error.generic': 'कुछ गड़बड़ हो गई – फिर से कोशिश करें',
  'field.error.saveFailed': 'इस फ़ोन में सेव नहीं हो सका – फिर से कोशिश करें',
  'field.error.notFound': 'पेज नहीं मिला',

  'sync.badge.offline': 'ऑफ़लाइन',
  'sync.badge.offlineSimulated': 'ऑफ़लाइन (अभ्यास)',
  'sync.badge.syncing': 'सिंक हो रहा है…',
  'sync.badge.pending': '{n} बाकी',
  'sync.badge.synced': '{time} पर सिंक हुआ',
  'sync.badge.neverSynced': 'अभी सिंक नहीं हुआ',
  'sync.badge.error': 'सिंक में गड़बड़ी – फिर से कोशिश होगी',
  'sync.badge.signIn': 'सिंक के लिए साइन इन करें',
  'sync.badge.forbidden': 'अनुमति नहीं है',
  'sync.badge.errors': 'सिंक में {n} गड़बड़ियाँ',
  'sync.badge.errorsOne': 'सिंक में 1 गड़बड़ी',
  'sync.now': 'अभी सिंक करें',
  'sync.lastSync': 'पिछला सिंक {time}',
  'sync.entity.mother': 'माँ',
  'sync.entity.visit': 'विज़िट',
  'sync.entity.task': 'काम',
  'sync.code.UNKNOWN_ENTITY': 'अनजान बदलाव',
  'sync.code.VALIDATION_ERROR': 'जानकारी सही नहीं है',
  'sync.code.OUT_OF_SCOPE': 'आपके गाँवों में नहीं है',
  'sync.code.MOTHER_NOT_FOUND': 'सर्वर पर यह माँ नहीं मिली',
  'sync.code.CONFLICT': 'रिकॉर्ड आपस में मेल नहीं खाता',
  'sync.code.MOTHER_INACTIVE': 'माँ का प्रसव हो चुका है',
  'sync.code.TASK_NOT_FOUND': 'काम नहीं मिला',
  'sync.code.TASK_CANCELLED': 'काम रद्द कर दिया गया है',

  'risk.RED': 'लाल – अधिक जोखिम',
  'risk.AMBER': 'पीला – निगरानी',
  'risk.GREEN': 'हरा – सामान्य',
  'risk.pending': 'जोखिम: सिंक बाकी',

  'flag.HB_SEVERE': 'गंभीर खून की कमी (एनीमिया)',
  'flag.HB_MODERATE': 'मध्यम खून की कमी (एनीमिया)',
  'flag.HB_MILD': 'हल्की खून की कमी (एनीमिया)',
  'flag.BP_SEVERE': 'बहुत ज़्यादा बीपी',
  'flag.BP_HIGH': 'बढ़ा हुआ बीपी',
  'flag.WEIGHT_LOSS': 'वज़न घटा है',
  'flag.WEIGHT_STATIC': 'वज़न नहीं बढ़ा',
  'flag.WEIGHT_GAIN_LOW': 'वज़न कम बढ़ रहा है',
  'flag.BMI_LOW': 'कम बीएमआई (दुबलापन)',
  'flag.LATE_REG': 'देर से पंजीकरण',
  'flag.VISIT_OVERDUE': 'विज़िट में देरी',

  'action.HOME_VISIT_48H': '48 घंटे के अंदर घर जाकर मिलें',
  'action.REFER_PHC': 'जाँच के लिए पीएचसी भेजें',
  'action.IFA_PER_PROTOCOL': 'नियम के अनुसार आयरन (IFA) की गोली दें या खुराक बदलें',
  'action.REPEAT_HB': 'Hb (खून) की जाँच दोबारा करें',
  'action.BP_RECHECK': 'बीपी दोबारा जाँचें',
  'action.ENSURE_THR': 'टेक-होम राशन (THR) मिलना पक्का करें',
  'action.DIET_COUNSEL': 'खान-पान की सलाह दें',
  'action.OTHER': 'अन्य काम',

  'validation.required': 'ज़रूरी है',
  'validation.number': 'नंबर लिखें',
  'validation.integer': 'पूरा नंबर लिखें',
  'validation.date': 'सही तारीख़ लिखें',
  'validation.nameLength': '1 से 100 अक्षर लिखें',
  'validation.ageRange': 'उम्र 14 से 55 साल के बीच होनी चाहिए',
  'validation.phone': '6, 7, 8 या 9 से शुरू होने वाला 10 अंकों का मोबाइल नंबर लिखें',
  'validation.village': 'गाँव चुनें',
  'validation.lmpFuture': 'LMP की तारीख़ आज के बाद की नहीं हो सकती',
  'validation.lmpRange': 'LMP पंजीकरण के दिन या उससे पहले, और ज़्यादा से ज़्यादा 44 हफ़्ते पहले की होनी चाहिए',
  'validation.heightRange': 'लंबाई 120 से 200 सेमी के बीच होनी चाहिए',
  'validation.weightRange': 'वज़न 25 से 150 किलो के बीच होना चाहिए',
  'validation.weightSource': 'चुनें कि वज़न कैसे लिया गया',
  'validation.hbRange': 'Hb 3.0 से 20.0 g/dL के बीच होना चाहिए',
  'validation.hbDecimals': 'दशमलव के बाद सिर्फ़ 1 अंक लिखें',
  'validation.hbSource': 'चुनें कि Hb कैसे लिया गया',
  'validation.bpBoth': 'बीपी के दोनों नंबर लिखें',
  'validation.bpSystolicRange': 'ऊपर वाला बीपी 60 से 260 के बीच होना चाहिए',
  'validation.bpDiastolicRange': 'नीचे वाला बीपी 30 से 160 के बीच होना चाहिए',
  'validation.bpOrder': 'ऊपर वाला बीपी नीचे वाले से ज़्यादा होना चाहिए',
  'validation.bpSource': 'चुनें कि बीपी कैसे लिया गया',
  'validation.tabletsRange': 'गोलियाँ 0 से 180 के बीच होनी चाहिए',
  'validation.notesLength': 'टिप्पणी ज़्यादा से ज़्यादा 500 अक्षर की हो सकती है',
  'validation.doneNoteLength': 'टिप्पणी ज़्यादा से ज़्यादा 300 अक्षर की हो सकती है',
  'validation.visitBeforeLmp': 'विज़िट की तारीख़ LMP से पहले की नहीं हो सकती',
  'validation.visitFuture': 'विज़िट की तारीख़ कल के बाद की नहीं हो सकती',
};

export const dict: Readonly<Record<Lang, Messages>> = { en, hi };

// --------------------------------------------------------------------------- functions

export type InterpolationVars = Readonly<Record<string, string | number>>;

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Replace each `{name}` placeholder that has a supplied value with `String(value)`.
 * Unknown placeholders and every other character are left untouched (Req 32.5).
 */
export function interpolate(template: string, vars?: InterpolationVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER_RE, (match, name: string) =>
    Object.hasOwn(vars, name) && vars[name] !== undefined ? String(vars[name]) : match,
  );
}

/** Dictionaries in the shape `resolveMessage` accepts; Hindi may be partial. */
export interface DictionarySet {
  readonly en: Readonly<Record<string, string>>;
  readonly hi: Readonly<Partial<Record<string, string>>>;
}

const warnedKeys = new Set<string>();

function warnOnce(id: string, message: string): void {
  if (!import.meta.env?.DEV || warnedKeys.has(id)) return;
  warnedKeys.add(id);
  console.warn(message);
}

/** Clears the warn-once memory (for tests). */
export function resetI18nWarnings(): void {
  warnedKeys.clear();
}

/**
 * Pure lookup over an explicit dictionary set: Hindi falls back to English, and
 * an unknown key returns the key itself. Missing keys warn once in DEV (Req 32.4).
 */
export function resolveMessage(
  dicts: DictionarySet,
  lang: Lang,
  key: string,
  vars?: InterpolationVars,
): string {
  let template: string | undefined;
  if (lang === 'hi') {
    template = Object.hasOwn(dicts.hi, key) ? dicts.hi[key] : undefined;
    if (template === undefined) {
      warnOnce(`hi:${key}`, `[i18n] missing Hindi key "${key}", using English`);
    }
  }
  if (template === undefined) {
    template = Object.hasOwn(dicts.en, key) ? dicts.en[key] : undefined;
  }
  if (template === undefined) {
    warnOnce(`en:${key}`, `[i18n] unknown key "${key}"`);
    return key;
  }
  return interpolate(template, vars);
}

/** Translate a known key with the app dictionaries. */
export function translate(lang: Lang, key: MessageKey, vars?: InterpolationVars): string {
  return resolveMessage(dict, lang, key, vars);
}

/** True when `key` exists in the English source dictionary. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** Look up `${prefix}${code}` for server-supplied codes; unknown codes show the code. */
function codeLabel(lang: Lang, prefix: string, code: string): string {
  const key = `${prefix}${code}`;
  return isMessageKey(key) ? translate(lang, key) : code;
}

export const flagLabel = (lang: Lang, code: string): string => codeLabel(lang, 'flag.', code);
export const actionLabel = (lang: Lang, code: string): string => codeLabel(lang, 'action.', code);
export const riskLabel = (lang: Lang, level: string): string => codeLabel(lang, 'risk.', level);
export const syncCodeLabel = (lang: Lang, code: string): string =>
  codeLabel(lang, 'sync.code.', code);

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'hi';
}

/** Stored language, or the default `'en'` when unset, invalid or storage is unavailable. */
export function readStoredLang(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Lang {
  try {
    const v = storage?.getItem(LANG_STORAGE_KEY);
    return isLang(v) ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export function storeLang(
  lang: Lang,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Storage can be blocked (private mode); the choice then lasts for the session only.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
