'use strict';

/**
 * ProCan Intake (iPad) — Phase 1
 * Fixes in this version:
 * - Scroll to bottom works regardless of summary (min-height + grid padding + card overflow)
 * - You can’t proceed to next step unless valid, but buttons are NOT disabled (so you can tap and see what’s missing)
 * - Branding uses your provided logo/wordmark image in the header
 */

const DRAFT_KEY = 'procan_intake_draft_v3';
const DISCOUNT_CODES = {
  // Add codes here:
  // CODE: { type: 'percent', value: 0.08, label: '...' }
  EA2026: { type: 'percent', value: 0.08, label: 'Code applied (8% off)' }
};

const FINAL_KEY = 'procan_latest_submission_v1';


const STRIPE_PUBLISHABLE_KEY = 'pk_test_51Std9ALhPorZTwtRmdJ8pSzwz1YqwnJVaAwYtiI8fy0AoXeIhLHRwu8t9T4I6sjoO2YrR4FhbAwPyr4rIksW25aN00LiPkQpwy';
// ===== Pricing (from your menu) =====
const PRICING = {
  trashCan: {
    biweekly: [
      { min: 1, max: 10, pricePerCanMonth: 25 },
      { min: 11, max: 20, pricePerCanMonth: 23 },
      { min: 21, max: 50, pricePerCanMonth: 20 },
      { min: 51, max: 100, pricePerCanMonth: 18 },
      { min: 101, max: Infinity, pricePerCanMonth: 16 }
    ],
    monthly: [
      { min: 1, max: 10, pricePerCanMonth: 18 },
      { min: 11, max: 20, pricePerCanMonth: 16 },
      { min: 21, max: 50, pricePerCanMonth: 14 },
      { min: 51, max: Infinity, pricePerCanMonth: 12 }
    ],
    visitsPerMonth: { biweekly: 2, monthly: 1 }
  },

  dumpsterPad: {
    small:  { weekly: 150, biweekly: 100, monthly: 75  },
    medium: { weekly: 250, biweekly: 175, monthly: 125 },
    large:  { weekly: 400, biweekly: 275, monthly: 200 },
    visitsPerMonth: { weekly: 4, biweekly: 2, monthly: 1 }
  },

  deepClean: { standard: 35, heavy: 50, extreme: 75 },

  billingDiscounts: { monthly: 0, quarterly: 0.05, annual: 0.10 },

  multiLocationDiscount(locations){
    const n = Number(locations || 1);
    if (n >= 7) return 0.10;
    if (n >= 4) return 0.08;
    if (n >= 2) return 0.05;
    return 0;
  }
};

// ===== DOM helpers =====
const $ = (id) => document.getElementById(id);

const els = {
  // menu
  btnMenu: $('btnMenu'),
  menu: $('menu'),
  btnToggleSummary: $('btnToggleSummary'),
  btnLoadDraft: $('btnLoadDraft'),
  btnWipeDraft: $('btnWipeDraft'),

  // step errors
  errorsStep1: $('errorsStep1'),
  errorsStep2: $('errorsStep2'),

  // form
  bizName: $('bizName'),
  contactName: $('contactName'),
  phone: $('phone'),
  email: $('email'),
  address: $('address'),

  canQty: $('canQty'),
  locations: $('locations'),
  serviceDay: $('serviceDay'),

  padAddon: $('padAddon'),
  padSize: $('padSize'),
  padCadence: $('padCadence'),

  deepClean: $('deepClean'),
  deepLevel: $('deepLevel'),
  deepApplies: $('deepApplies'),
  deepQty: $('deepQty'),

  notes: $('notes'),
  startDate: $('startDate'),
  oneTimeOnly: $('oneTimeOnly'),
  depositToggle: $('depositToggle'),
  depositRow: $('depositRow'),

  // discount
  discountCode: $('discountCode'),
  applyDiscount: $('applyDiscount'),
  removeDiscount: $('removeDiscount'),
  discountApplied: $('discountApplied'),

  // transition
  transitionOverlay: $('transitionOverlay'),
  bootSub: $('bootSub'),

  // summary (right)
  badge: $('summaryBadge'),
  kpiMonthly: $('kpiMonthly'),
  kpiDue: $('kpiDue'),
  kpiDiscounts: $('kpiDiscounts'),
  breakdown: $('breakdown'),

  // embedded quote (step 2)
  qMonthly: $('qMonthly'),
  qDue: $('qDue'),
  qDisc: $('qDisc'),
  embeddedBreakdown: $('embeddedBreakdown'),

  // review
  reviewBox: $('reviewBox'),
  payloadPre: $('payloadPre'),

  // nav
  next1: $('next1'),
  next2: $('next2'),
  back2: $('back2'),
  back3: $('back3'),
  saveAndContinue: $('saveAndContinue'),
  paymentMethod: $('paymentMethod'),
  paymentBlock: $('paymentBlock'),
  agreeTerms: $('agreeTerms'),

  // final screen timer
  sessionTimerValue: $('sessionTimerValue')
};

// Cash/Check should only be available when "one-time clean only" is selected.
function syncPaymentVisibility(opts={}){
  const oneTime = !!(els.oneTimeOnly && els.oneTimeOnly.checked);
  const deposit = !!(els.depositToggle && els.depositToggle.checked);

  // Deposit is for reserving a recurring spot; it can't be combined with one-time service.
  if (oneTime && deposit && els.depositToggle){
    els.depositToggle.checked = false;
  }

  // Hide/disable deposit UI when one-time is selected
  if (els.depositRow){
    els.depositRow.style.display = oneTime ? 'none' : '';
  }

  if (els.paymentBlock){
    els.paymentBlock.style.display = oneTime ? '' : 'none';
  }
  // If not one-time, force Card so recurring flows always use Stripe.
  if (!oneTime){
    setPaymentMethod('card', { silent:true });
  }
  // Remember deposit state
  uiState.deposit = !!(els.depositToggle && els.depositToggle.checked && !oneTime);
  const oneTimeNow = !!(els.oneTimeOnly && els.oneTimeOnly.checked);
  const startISO = els.startDate ? String(els.startDate.value||'').trim() : '';
  uiState.captureOnly = (!oneTimeNow && !uiState.deposit && isFutureStartDate(startISO));
  if (!opts.silent) updateConfirmGate();
}

// ===== UI State =====
let uiState = {
  step: 1,
  discountCode: '',
  discountRate: 0,
  cadence: 'biweekly', // biweekly | monthly | none
  billing: 'monthly',  // monthly | quarterly | annual
  deposit: false,
  captureOnly: false,
  hideSummary: true,
  step2Confirmed: false,
  suppressAutoAdvance: true
};

let autosaveEnabled = false;
let suspendAutosave = false;

let attemptedNext1 = false;
let attemptedNext2 = false;

// ===== Formatting =====
function money(n){
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function tierPrice(tiers, qty){
  const q = Number(qty || 0);
  for (const t of tiers){
    if (q >= t.min && q <= t.max) return Number(t.pricePerCanMonth);
  }
  return 0;
}
function monthsInTerm(bill){
  return bill === 'quarterly' ? 3 : (bill === 'annual' ? 12 : 1);
}
function escapeHtml(text){
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}
function cryptoId(){
  try{
    const a = crypto.getRandomValues(new Uint32Array(2));
    return `${a[0].toString(16)}${a[1].toString(16)}`;
  }catch{
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
}
function normalizePhone(s){
  return String(s || '').replace(/[^\d]/g, '');
}
function isValidEmail(s){
  const v = String(s || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isFutureStartDate(startDateISO){
  const s = String(startDateISO || '').trim();
  if (!s) return false;
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return d.getTime() > t0.getTime();
}



// ===== Discount codes =====
function applyDiscountCode(raw, opts={}){
  const code = String(raw || '').trim().toUpperCase();
  if (!code){
    uiState.discountCode = '';
    uiState.discountRate = 0;
    if (els.discountApplied) els.discountApplied.textContent = '';
    if (els.removeDiscount) els.removeDiscount.hidden = true;
    return { ok:true, cleared:true };
  }
  const def = DISCOUNT_CODES[code];
  if (!def){
    if (!opts.silent) alert('Invalid discount code.');
    uiState.discountCode = '';
    uiState.discountRate = 0;
    if (els.discountApplied) els.discountApplied.textContent = '';
    if (els.removeDiscount) els.removeDiscount.hidden = true;
    return { ok:false };
  }
  if (def.type === 'percent'){
    uiState.discountCode = code;
    uiState.discountRate = Math.max(0, Math.min(0.90, Number(def.value || 0)));
    if (els.discountApplied) els.discountApplied.textContent = `Applied: ${def.label || code}`;
    if (els.removeDiscount) els.removeDiscount.hidden = false;
    return { ok:true };
  }
  if (!opts.silent) alert('Unsupported discount type.');
  return { ok:false };
}

// ===== Smooth transition =====
function showTransition(label){
  if (!els.transitionOverlay) return;
  if (els.bootSub) els.bootSub.textContent = label || 'Processing…';
  els.transitionOverlay.classList.add('show');
  els.transitionOverlay.setAttribute('aria-hidden','false');

  // restart animations
  const fill = els.transitionOverlay.querySelector('.boot-bar-fill');
  if (fill){
    fill.style.animation = 'none';
    void fill.offsetHeight;
    fill.style.animation = '';
  }
}
function hideTransition(){
  if (!els.transitionOverlay) return;
  els.transitionOverlay.classList.remove('show');
  els.transitionOverlay.setAttribute('aria-hidden','true');
}
function transitionToStep(target, label, cb){
  showTransition(label);
  window.setTimeout(() => {
    cb();
    window.setTimeout(hideTransition, 120);
  }, 520);
}


// ===== Final screen session timer =====
const FINAL_SCREEN_RESET_SECONDS = 5 * 60; // 5 minutes
let finalTimerInterval = null;
let finalTimerDeadlineMs = 0;

function formatMMSS(totalSeconds){
  const s = Math.max(0, Number(totalSeconds || 0));
  const mm = String(Math.floor(s / 60)).padStart(2,'0');
  const ss = String(s % 60).padStart(2,'0');
  return `${mm}:${ss}`;
}

function renderFinalTimer(secondsLeft){
  if (!els.sessionTimerValue) return;
  els.sessionTimerValue.textContent = formatMMSS(secondsLeft);
}

function stopFinalTimer(){
  if (finalTimerInterval) window.clearInterval(finalTimerInterval);
  finalTimerInterval = null;
  finalTimerDeadlineMs = 0;
}

function silentResetToDefaults(){
  // Mirror wipeDraft() behavior without confirm/alert/transition.
  suspendAutosave = true;
  autosaveEnabled = false;

  try{
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(FINAL_KEY);
  }catch(e){}

  els.bizName.value = '';
  els.contactName.value = '';
  els.phone.value = '';
  els.email.value = '';
  els.address.value = '';
  els.canQty.value = '0';
  els.locations.value = '1';
  els.serviceDay.value = 'unspecified';
  els.padAddon.checked = false;
  els.padSize.value = 'small';
  els.padCadence.value = 'weekly';
  els.deepClean.checked = false;
  els.deepLevel.value = 'standard';
  els.deepApplies.value = 'allCans';
  els.deepQty.value = '0';
  els.notes.value = '';
  els.oneTimeOnly.checked = false;
  if (els.depositToggle) els.depositToggle.checked = false;
  if (els.discountCode) els.discountCode.value = '';
  if (els.discountApplied) els.discountApplied.textContent = '';

  uiState.cadence = 'biweekly';
  uiState.billing = 'monthly';
  uiState.hideSummary = true;
  uiState.step2Confirmed = false;
  uiState.discountCode = '';
  uiState.discountRate = 0;
  uiState.deposit = false;

  attemptedNext1 = false;
  attemptedNext2 = false;

  setCadence(uiState.cadence, { silent:true });
  setBilling(uiState.billing, { silent:true });

  showErrors(els.errorsStep1, []);
  showErrors(els.errorsStep2, []);
  applySummaryVisibility();

  update({ silent:true });

  suspendAutosave = false;
}

function resetToStep1WithTransition(){
  stopFinalTimer();
  transitionToStep(1, 'Session expired — resetting…', () => {
    silentResetToDefaults();
    setStep(1, { silent:true });
    renderFinalTimer(FINAL_SCREEN_RESET_SECONDS);
  });
}

function startFinalTimer(){
  stopFinalTimer();
  finalTimerDeadlineMs = Date.now() + (FINAL_SCREEN_RESET_SECONDS * 1000);

  const tick = () => {
    const left = Math.max(0, Math.ceil((finalTimerDeadlineMs - Date.now()) / 1000));
    renderFinalTimer(left);
    if (left <= 0){
      stopFinalTimer();
      resetToStep1WithTransition();
    }
  };

  tick();
  finalTimerInterval = window.setInterval(tick, 1000);
}

// ===== Auto-advance (no visible page indicators) =====
let autoAdvanceTimer = null;
function scheduleAutoAdvance(){
  if (autoAdvanceTimer) window.clearTimeout(autoAdvanceTimer);
  if (!autosaveEnabled) return;
  if (uiState.suppressAutoAdvance) return;

  // Manual navigation only: debounce autosave, never change steps automatically.
  autoAdvanceTimer = window.setTimeout(() => {
    saveDraft();
  }, 500);
}

// ===== Quote computation =====
function computeQuote(){
  const locations = Math.max(1, Number(els.locations.value || 1));
  const cadence = uiState.cadence;
  const canQty = Math.max(0, Number(els.canQty.value || 0));

  const billing = uiState.billing;
  const billDisc = PRICING.billingDiscounts[billing] || 0;
  const locDisc = PRICING.multiLocationDiscount(locations) || 0;

  const oneTimeOnly = !!els.oneTimeOnly.checked;
  const deposit = !!(els.depositToggle && els.depositToggle.checked) && !oneTimeOnly;

  let trashMonthly = 0;
  let trashVisitsPerMonth = 0;
  let trashPerCan = 0;

  if (cadence !== 'none' && canQty > 0){
    trashPerCan = tierPrice(PRICING.trashCan[cadence], canQty);
    trashMonthly = trashPerCan * canQty;
    trashVisitsPerMonth = PRICING.trashCan.visitsPerMonth[cadence] || 1;
  }

  let padMonthly = 0;
  let padVisitsPerMonth = 0;
  if (els.padAddon.checked){
    const sizeKey = els.padSize.value || 'small';
    const padCadence = els.padCadence.value || 'biweekly';
    const row = PRICING.dumpsterPad[sizeKey];
    padMonthly = Number(row?.[padCadence] || 0);
    padVisitsPerMonth = Number(PRICING.dumpsterPad.visitsPerMonth[padCadence] || 1);
  }

  const baseMonthly = trashMonthly + padMonthly;
  const afterLocation = baseMonthly * (1 - locDisc);
  const afterBilling = afterLocation * (1 - billDisc);

  const codeDisc = Math.max(0, Math.min(0.90, Number(uiState.discountRate || 0)));
  const monthlyTotal = afterBilling * (1 - codeDisc);

  if (billing === 'annual' && monthlyTotal < 1000){
    return { ok: false, error: 'Annual prepay requires $1,000+/month contract value.' };
  }

  let deepCleanTotal = 0;
  if (els.deepClean.checked){
    const level = els.deepLevel.value || 'standard';
    const perCan = Number(PRICING.deepClean[level] || 0);

    const appliesMode = els.deepApplies.value || 'allCans';
    const qty = appliesMode === 'someCans'
      ? Math.max(0, Number(els.deepQty.value || 0))
      : canQty;

    deepCleanTotal = perCan * qty;
  }

  const termMonths = monthsInTerm(billing);
  const trashPerVisit = (trashMonthly > 0 && trashVisitsPerMonth > 0) ? (trashMonthly / trashVisitsPerMonth) : 0;
  const padPerVisit   = (padMonthly > 0 && padVisitsPerMonth > 0) ? (padMonthly / padVisitsPerMonth) : 0;
  let perVisitTotal = (trashPerVisit + padPerVisit) * (1 - codeDisc);

  // One-time service pricing rule:
  // - Trash cans: charge the FULL biweekly tier "per-can per month" price as a one-time per-can price.
  //   (i.e., NOT a per-visit split.)
  // - Dumpster pad: charge the selected cadence's monthly price as a one-time price (no per-visit split).
  let dueToday = 0;
  let normalDueToday = 0;
  if (oneTimeOnly){
    let trashOneTime = 0;
    if (canQty > 0 && cadence !== 'none'){
      const oneTimePerCan = tierPrice(PRICING.trashCan.biweekly, canQty);
      trashOneTime = oneTimePerCan * canQty;
    }

    let padOneTime = 0;
    if (els.padAddon.checked){
      const sizeKey = els.padSize.value || 'small';
      const padCadence = els.padCadence.value || 'biweekly';
      const row = PRICING.dumpsterPad[sizeKey];
      padOneTime = Number(row?.[padCadence] || 0);
    }

    perVisitTotal = (trashOneTime + padOneTime) * (1 - codeDisc);
    normalDueToday = perVisitTotal + deepCleanTotal;
    dueToday = normalDueToday;
  } else {
    normalDueToday = (monthlyTotal * termMonths) + deepCleanTotal;
    dueToday = normalDueToday;
  }

  // Deposit reservation rule: keep full quote details, but charge $25 today.
  // (Remaining balance collected at launch / start date.)
  if (deposit){
    dueToday = 25;
  }

  // Card capture (no charge): if start date is in the future, save card now and charge on first service.
  if (!oneTimeOnly && !deposit && uiState.captureOnly){
    dueToday = 0;
  }

  const discountTotal = Math.max(0, baseMonthly - monthlyTotal);

  return {
    ok: true,
    discountCode: uiState.discountCode || '',
    codeDisc,

    cadence, canQty, trashPerCan, trashMonthly, trashVisitsPerMonth,
    padMonthly, padVisitsPerMonth,
    billing, termMonths,
    locations, locDisc, billDisc,
    baseMonthly, monthlyTotal,
    perVisitTotal,
    deepCleanTotal,
    dueToday,
    normalDueToday,
    isDeposit: deposit,
    captureOnly: uiState.captureOnly,
    discountTotal
  };
}

// ===== Validation =====
function validateStep1(){
  const errs = [];
  const biz = els.bizName.value.trim();
  const name = els.contactName.value.trim();
  const phone = normalizePhone(els.phone.value);
  const email = els.email.value.trim();
  const addr = els.address.value.trim();

  if (!biz) errs.push('Business / account name is required.');
  if (!name) errs.push('Primary contact name is required.');
  if (!isValidEmail(email)) errs.push('A valid email is required (for contract + receipt).');
  if (phone.length < 10) errs.push('A valid phone number is required.');
  if (!addr) errs.push('Service address is required.');

  const canQty = Number(els.canQty.value || 0);
  const hasTrash = (uiState.cadence !== 'none' && canQty > 0);
  const hasPad = !!els.padAddon.checked;

  if (!hasTrash && !hasPad){
    errs.push('Select at least one service: Trash can cleaning (with # of cans) and/or Dumpster pad add-on.');
  }
  if (uiState.cadence !== 'none' && canQty <= 0 && !hasPad){
    errs.push('Enter the total number of cans (must be greater than 0).');
  }
  return errs;
}

function validateStep2(){
  const errs = [];
  const d = (els.startDate.value || '').trim();
  if (!d) errs.push('Start date is required.');
  const q = computeQuote();
  if (!q.ok) errs.push(q.error || 'Fix quote inputs.');
  return errs;
}

function showErrors(container, errs){
  if (!container) return;
  if (!errs || errs.length === 0){
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `<ul>${errs.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}

function setAutosaveEnabled(){
  if (!autosaveEnabled) autosaveEnabled = true;
}

// ===== Draft persistence =====
function collectForm(){
  return {
    bizName: els.bizName.value,
    contactName: els.contactName.value,
    phone: els.phone.value,
    email: els.email.value,
    address: els.address.value,
    canQty: els.canQty.value,
    locations: els.locations.value,
    serviceDay: els.serviceDay.value,
    padAddon: els.padAddon.checked,
    padSize: els.padSize.value,
    padCadence: els.padCadence.value,
    deepClean: els.deepClean.checked,
    deepLevel: els.deepLevel.value,
    deepApplies: els.deepApplies.value,
    deepQty: els.deepQty.value,
    notes: els.notes.value,
    startDate: els.startDate.value,
    oneTimeOnly: els.oneTimeOnly.checked,
    deposit: !!(els.depositToggle && els.depositToggle.checked),
    paymentMethod: els.paymentMethod ? els.paymentMethod.value : 'card',
    discountCode: els.discountCode ? els.discountCode.value : ''
  };
}

function buildSubmission(q){
  return {
    meta: { id: cryptoId(), createdAt: new Date().toISOString(), source: 'procan-intake' },
    business: {
      name: els.bizName.value.trim(),
      contactName: els.contactName.value.trim(),
      phone: els.phone.value.trim(),
      email: els.email.value.trim(),
      address: els.address.value.trim(),
      locations: q.locations,
      preferredServiceDay: els.serviceDay.value || 'unspecified'
    },
    services: {
      trash: { cadence: q.cadence, cans: q.canQty, tierPricePerCanMonth: q.trashPerCan },
      pad: {
        enabled: !!els.padAddon.checked,
        size: els.padSize.value || null,
        cadence: els.padCadence.value || null,
        monthlyValue: q.padMonthly
      },
      deepClean: {
        enabled: !!els.deepClean.checked,
        level: els.deepLevel.value || null,
        applies: els.deepApplies.value || null,
        qty: Number(els.deepQty.value || 0),
        total: q.deepCleanTotal
      }
    },
    billing: {
      option: q.billing,
      monthsInTerm: q.termMonths,
      startDate: els.startDate.value || '',
      oneTimeOnly: !!els.oneTimeOnly.checked,
      captureOnly: !!uiState.captureOnly,
      deposit: !!q.isDeposit,
      paymentMethod: (els.paymentMethod && els.paymentMethod.value === 'cash') ? 'cash' : 'card'
    },
    pricing: {
      discountCode: q.discountCode || '',
      discountCodeRate: q.codeDisc || 0,
      baseMonthly: q.baseMonthly,
      monthlyTotal: q.monthlyTotal,
      perVisitTotal: q.perVisitTotal,
      discountTotal: q.discountTotal,
      locationDiscountRate: q.locDisc,
      billingDiscountRate: q.billDisc,
      dueToday: q.dueToday,
      normalDueToday: q.normalDueToday,
      isDeposit: !!q.isDeposit,
      depositAmount: q.isDeposit ? 25 : 0
    },
    notes: els.notes.value.trim()
  };
}

function saveDraft(){
  if (!autosaveEnabled || suspendAutosave) return;
  const q = computeQuote();
  const payload = q.ok ? buildSubmission(q) : null;
  const draft = { uiState, form: collectForm(), payload };
  try{ localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch(e){}
}

function loadDraft(){
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return alert('No draft found on this device.');
  const d = JSON.parse(raw);

  suspendAutosave = true;
  try{
    if (d.uiState) uiState = { ...uiState, ...d.uiState };
    // Always start with summary hidden (you can toggle it as needed)
    uiState.hideSummary = true;
    uiState.step2Confirmed = false;

    const f = d.form || {};
    els.bizName.value = f.bizName || '';
    els.contactName.value = f.contactName || '';
    els.phone.value = f.phone || '';
    els.email.value = f.email || '';
    els.address.value = f.address || '';
    els.canQty.value = f.canQty ?? '0';
    els.locations.value = f.locations ?? '1';
    els.serviceDay.value = f.serviceDay || 'unspecified';
    els.padAddon.checked = !!f.padAddon;
    els.padSize.value = f.padSize || 'small';
    els.padCadence.value = f.padCadence || 'weekly';
    els.deepClean.checked = !!f.deepClean;
    els.deepLevel.value = f.deepLevel || 'standard';
    els.deepApplies.value = f.deepApplies || 'allCans';
    els.deepQty.value = f.deepQty ?? '0';
    els.notes.value = f.notes || '';
    els.startDate.value = f.startDate || els.startDate.value || '';
    els.oneTimeOnly.checked = !!f.oneTimeOnly;
    if (els.depositToggle) els.depositToggle.checked = !!f.deposit;

    if (els.paymentMethod){
      els.paymentMethod.value = (f.paymentMethod === 'cash') ? 'cash' : 'card';
      setPaymentMethod(els.paymentMethod.value, { silent:true });
    }

    if (els.discountCode){
      els.discountCode.value = f.discountCode || '';
      applyDiscountCode(els.discountCode.value, { silent:true });
    }

    attemptedNext1 = false;
    attemptedNext2 = false;
    showErrors(els.errorsStep1, []);
    showErrors(els.errorsStep2, []);

    setCadence(uiState.cadence, { silent:true });
    setBilling(uiState.billing, { silent:true });
    setStep(uiState.step || 1, { silent:true });

    applySummaryVisibility();
    update({ silent:true });
  } finally {
    autosaveEnabled = false;
    suspendAutosave = false;
    alert('Draft loaded.');
  }
}

function wipeDraft(){
  const ok = confirm('Wipe the saved draft on this device?');
  if (!ok) return;

  suspendAutosave = true;
  autosaveEnabled = false;

  try{
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(FINAL_KEY);
  }catch(e){}

  els.bizName.value = '';
  els.contactName.value = '';
  els.phone.value = '';
  els.email.value = '';
  els.address.value = '';
  els.canQty.value = '0';
  els.locations.value = '1';
  els.serviceDay.value = 'unspecified';
  els.padAddon.checked = false;
  els.padSize.value = 'small';
  els.padCadence.value = 'weekly';
  els.deepClean.checked = false;
  els.deepLevel.value = 'standard';
  els.deepApplies.value = 'allCans';
  els.deepQty.value = '0';
  els.notes.value = '';
  els.oneTimeOnly.checked = false;
  if (els.discountCode) els.discountCode.value = '';
  if (els.discountApplied) els.discountApplied.textContent = '';

  uiState.cadence = 'biweekly';
  uiState.billing = 'monthly';
  uiState.hideSummary = true;
  uiState.step2Confirmed = false;
  uiState.discountCode = '';
  uiState.discountRate = 0;

  attemptedNext1 = false;
  attemptedNext2 = false;

  setCadence(uiState.cadence, { silent:true });
  setBilling(uiState.billing, { silent:true });
  setPaymentMethod((els.paymentMethod && els.paymentMethod.value) ? els.paymentMethod.value : 'card', { silent:true });
    syncPaymentVisibility({ silent:true });
  setStep(1, { silent:true });

  showErrors(els.errorsStep1, []);
  showErrors(els.errorsStep2, []);
  applySummaryVisibility();

  update({ silent:true });

  suspendAutosave = false;
  alert('Draft wiped.');
}

// ===== Menu =====
function toggleMenu(open){
  const isOpen = els.menu.classList.contains('open');
  const next = (open === undefined) ? !isOpen : !!open;
  els.menu.classList.toggle('open', next);
  els.menu.setAttribute('aria-hidden', next ? 'false' : 'true');
}
function bindMenu(){
  els.btnMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', () => toggleMenu(false));
  els.menu.addEventListener('click', (e) => e.stopPropagation());

  els.btnToggleSummary.addEventListener('click', () => {
    // Allow toggle on any page before final. Final always shows.
    if (uiState.step === 3) return;
    uiState.hideSummary = !uiState.hideSummary;
    applySummaryVisibility();
    toggleMenu(false);
    saveDraft();
  });
  els.btnLoadDraft.addEventListener('click', () => { toggleMenu(false); loadDraft(); });
  els.btnWipeDraft.addEventListener('click', () => { toggleMenu(false); wipeDraft(); });
}

function applySummaryVisibility(){
  // Hidden by default on steps 1–2. Always shown on final review (step 3).
  const shouldHide = (uiState.step !== 3) && !!uiState.hideSummary;
  document.body.classList.toggle('hide-summary', shouldHide);
}

function updateConfirmGate(){
  if (!els.saveAndContinue) return;
  if (uiState.step !== 3) return;
  const ok = !!(els.agreeTerms && els.agreeTerms.checked);
  els.saveAndContinue.disabled = !ok;
  els.saveAndContinue.classList.toggle('ready', ok);
}


// ===== Steps =====
function setCadence(c, opts={}){
  uiState.cadence = c;
  document.querySelectorAll('[data-cadence]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-cadence') === c);
  });
  if (c === 'none') els.canQty.value = 0;
  if (!opts.silent) update();
}
function setBilling(b, opts={}){
  uiState.billing = b;
  document.querySelectorAll('[data-bill]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-bill') === b);
  });
  if (!opts.silent) update();
}

function setPaymentMethod(p, opts={}){
  const v = (p === 'cash') ? 'cash' : 'card';
  if (els.paymentMethod) els.paymentMethod.value = v;
  // Toggle segmented UI
  document.querySelectorAll('[data-pay]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pay === v);
  });
  if (!opts.silent) updateConfirmGate();
}
function setStep(n, opts={}){
  uiState.step = n;
  uiState.suppressAutoAdvance = true;
  document.querySelectorAll('.step-panel').forEach(p => p.classList.toggle('active', Number(p.dataset.panel) === n));
  // Entering step 2: require interaction before auto-advance.
  if (n === 2) uiState.step2Confirmed = false;
  // Final review always shows the summary (without changing your toggle state).
  applySummaryVisibility();
  // Payment method UI is only relevant on final review, and only for one-time orders.
  syncPaymentVisibility({ silent:true });

  // Final screen timer: runs only while on Step 3
  if (n === 3) startFinalTimer();
  else { stopFinalTimer(); renderFinalTimer(FINAL_SCREEN_RESET_SECONDS); }

  if (!opts.silent) saveDraft();
  update({ silent: opts.silent });
  updateConfirmGate();
  scheduleAutoAdvance();
}

// ===== Render =====
function update(opts={}){
  const padOn = !!els.padAddon.checked;
  els.padSize.disabled = !padOn;
  els.padCadence.disabled = !padOn;
  document.querySelectorAll('.pad-options').forEach(x => x.classList.toggle('enabled', padOn));

  const deepOn = !!els.deepClean.checked;
  els.deepLevel.disabled = !deepOn;
  els.deepApplies.disabled = !deepOn;
  const someCans = deepOn && (els.deepApplies.value === 'someCans');
  els.deepQty.disabled = !someCans;
  document.querySelectorAll('.deep-options').forEach(x => x.classList.toggle('enabled', deepOn));

  if (deepOn && els.deepApplies.value === 'allCans'){
    els.deepQty.value = Number(els.canQty.value || 0);
  }

  const q = computeQuote();

  if (!q.ok){
    els.badge.textContent = q.error || 'Fix inputs';
    els.badge.style.borderColor = 'rgba(239,68,68,.35)';
    els.kpiMonthly.textContent = money(0);
    els.kpiDue.textContent = money(0);
    els.kpiDiscounts.textContent = money(0);
    els.breakdown.innerHTML = `<b>Issue:</b> ${escapeHtml(q.error || 'Invalid inputs')}`;

    els.qMonthly.textContent = money(0);
    if (els.qDue) els.qDue.textContent = money(0);
    els.qDisc.textContent = money(0);
    els.embeddedBreakdown.innerHTML = `<b>Issue:</b> ${escapeHtml(q.error || 'Invalid inputs')}`;
  } else {
    els.badge.textContent = 'Draft';
    els.badge.style.borderColor = 'rgba(255,255,255,.10)';

    els.kpiMonthly.textContent = money(q.monthlyTotal);
    els.kpiDue.textContent = money(q.dueToday);
    if (q.captureOnly){ els.kpiDue.title = 'Card will be saved now; you will be charged when service begins.'; }
    els.kpiDiscounts.textContent = money(q.discountTotal);

    els.qMonthly.textContent = money(q.monthlyTotal);
    if (els.qDue) els.qDue.textContent = money(q.dueToday);
    els.qDisc.textContent = money(q.discountTotal);

    const cadenceLabel = q.cadence === 'biweekly' ? 'Biweekly' : (q.cadence === 'monthly' ? 'Monthly' : 'None');
    const billLabel = q.billing[0].toUpperCase() + q.billing.slice(1);
    const locPct = Math.round(q.locDisc * 100);
    const billPct = Math.round(q.billDisc * 100);

    const trashLine = (q.trashMonthly > 0)
      ? `Trash cans: <b>${q.canQty}</b> @ <b>${money(q.trashPerCan)}</b>/can/mo → <b>${money(q.trashMonthly)}</b>/mo`
      : `Trash cans: <b>Not selected</b>`;

    const padLine = (q.padMonthly > 0)
      ? `Dumpster pad: <b>${money(q.padMonthly)}</b>/mo`
      : `Dumpster pad: <b>Not added</b>`;

    const deepLine = (q.deepCleanTotal > 0)
      ? `Deep clean (one-time): <b>${money(q.deepCleanTotal)}</b>`
      : `Deep clean: <b>No</b>`;

    const discLine = (q.discountTotal > 0)
      ? `Discounts: ${locPct ? `<b>${locPct}%</b> multi-location` : ''}${locPct && billPct ? ' + ' : ''}${billPct ? `<b>${billPct}%</b> billing` : ''}`
      : `Discounts: <b>None</b>`;

    const codePct = Math.round((q.codeDisc || 0) * 100);
    const codeLine = (q.discountCode && codePct)
      ? `Discount code: <b>${escapeHtml(q.discountCode)}</b> (${codePct}% off)`
      : '';

      const deepSuffix = (q.deepCleanTotal > 0) ? ' + deep clean' : '';

      const dueRule = q.isDeposit
        ? `Due today is a <b>$25 deposit</b> (reserves spot). Normal due at launch: <b>${money(q.normalDueToday)}</b>${deepSuffix}`
        : (els.oneTimeOnly.checked
            ? `Due today is <b>one visit</b>${deepSuffix}`
            : `Due today is <b>${q.termMonths} month(s)</b> prepay${deepSuffix}`);
      
    const breakdownHtml = `
      <div><b>Cadence:</b> ${cadenceLabel}</div>
      <div><b>Billing:</b> ${billLabel}</div>
      <div><b>Locations:</b> ${q.locations}</div>
      <div class="line"></div>
      <div>${trashLine}</div>
      <div>${padLine}</div>
      <div>${deepLine}</div>
      <div class="line"></div>
      <div>${discLine}</div>
      ${codeLine ? `<div>${codeLine}</div>` : ``}
      <div><b>Per-visit estimate:</b> ${money(q.perVisitTotal)}</div>
      <div style="margin-top:8px; opacity:.85;">${dueRule}</div>
    `;
    els.breakdown.innerHTML = breakdownHtml;
    els.embeddedBreakdown.innerHTML = breakdownHtml;
  }

  const step1Errs = validateStep1();
  const step2Errs = validateStep2();

  if (attemptedNext1) showErrors(els.errorsStep1, step1Errs);
  else showErrors(els.errorsStep1, []);

  if (attemptedNext2) showErrors(els.errorsStep2, step2Errs);
  else showErrors(els.errorsStep2, []);

  if (uiState.step === 3) renderReview();

  if (!opts.silent) saveDraft();
}

function renderReview(){
  const q = computeQuote();
  if (!q.ok){
    els.reviewBox.innerHTML = `<div><b>Issue:</b> ${escapeHtml(q.error || 'Fix inputs')}</div>`;
    els.payloadPre.textContent = '';
    return;
  }
  const submission = buildSubmission(q);

  els.reviewBox.innerHTML = `
    <div class="review-grid">
      <div class="review-item"><b>Business:</b> ${escapeHtml(submission.business.name || '')}</div>
      <div class="review-item"><b>Contact:</b> ${escapeHtml(submission.business.contactName || '')}</div>
      <div class="review-item"><b>Email:</b> ${escapeHtml(submission.business.email || '')}</div>
      <div class="review-item"><b>Phone:</b> ${escapeHtml(submission.business.phone || '')}</div>
      <div class="review-item"><b>Address:</b> ${escapeHtml(submission.business.address || '')}</div>
      <div class="review-item"><b>Start Date:</b> ${escapeHtml(submission.billing.startDate || '')}</div>

      <div class="review-item"><b>Trash Cadence:</b> ${escapeHtml(submission.services.trash.cadence)}</div>
      <div class="review-item"><b># Cans:</b> ${submission.services.trash.cans}</div>
      <div class="review-item"><b>Pad Add-on:</b> ${submission.services.pad.enabled ? 'Yes' : 'No'}</div>
      <div class="review-item"><b>Deep Clean:</b> ${submission.services.deepClean.enabled ? 'Yes' : 'No'}</div>

      <div class="review-item"><b>Monthly Total:</b> ${money(submission.pricing.monthlyTotal)}</div>
      <div class="review-item"><b>Due Today:</b> ${money(submission.pricing.dueToday)}${submission.pricing.isDeposit ? ' (deposit)' : (submission.billing.captureOnly ? ' (card saved; charged at start)' : '')}</div>
      ${submission.pricing.isDeposit ? `<div class="review-item"><b>Normal Due at Launch:</b> ${money(submission.pricing.normalDueToday)}</div>` : ``}
      <div class="review-item"><b>Discounts:</b> ${money(submission.pricing.discountTotal)}</div>
      <div class="review-item"><b>Per Visit:</b> ${money(submission.pricing.perVisitTotal)}</div>
    </div>
  `;
  els.payloadPre.textContent = JSON.stringify(submission, null, 2);
}


// ===== Stripe Checkout (Payments) =====
// This requires a backend endpoint that creates the Checkout Session:
//   POST /api/create-checkout-session  -> { url, sessionId }
// Secret key MUST stay on the server (Vercel env vars).
let stripeClient = null;
function getStripe(){
  if (!stripeClient){
    if (!window.Stripe) throw new Error('Stripe.js failed to load.');
    stripeClient = window.Stripe(STRIPE_PUBLISHABLE_KEY);
  }
  return stripeClient;
}


async function geocodeBusinessAddress(submission){
  try{
    const addr = String(submission?.business?.address || '').trim();
    if (!addr) return submission;
    // Don't re-geocode if already present
    if (submission?.business?.geoLat && submission?.business?.geoLng) return submission;

    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: addr,
      format: 'json',
      limit: '1',
      addressdetails: '1'
    }).toString();

    const resp = await fetch(url, { headers: { 'Accept': 'application/json' }});
    if (!resp.ok) return submission;
    const data = await resp.json().catch(()=> []);
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit || !hit.lat || !hit.lon) return submission;

    submission.business.geoLat = String(hit.lat);
    submission.business.geoLng = String(hit.lon);
    submission.business.geoSource = 'nominatim';
    submission.business.geoAccuracy = hit.type || '';
    return submission;
  }catch(e){
    return submission;
  }
}

async function startStripeCheckout(submission){
  // Ensure latest payload is saved locally (so nothing is lost if checkout is closed)
  try{ localStorage.setItem(FINAL_KEY, JSON.stringify(submission)); }catch(e){}

  const btn = els.saveAndContinue;
  const oldText = btn ? btn.textContent : '';

  if (btn){
    btn.disabled = true;
    btn.textContent = 'Opening Checkout…';
  }

  try{
    submission = await geocodeBusinessAddress(submission);
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission })
    });

    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`Checkout error (${res.status}): ${t || 'Failed to create session'}`);
    }

    const data = await res.json();
    if (data.url){
      window.location.href = data.url;
      return;
    }
    if (data.sessionId){
      const stripe = getStripe();
      const { error } = await stripe.redirectToCheckout({ sessionId: data.sessionId });
      if (error) throw error;
      return;
    }
    throw new Error('Checkout session response missing url/sessionId.');
  } finally {
    if (btn){
      btn.disabled = false;
      btn.textContent = oldText || 'Confirm';
    }
  }
}

async function startCashOrder(submission){
  // Save payload locally
  try{ localStorage.setItem(FINAL_KEY, JSON.stringify(submission)); }catch(e){}

  const btn = els.saveAndContinue;
  const oldText = btn ? btn.textContent : '';
  if (btn){
    btn.disabled = true;
    btn.textContent = 'Saving cash order…';
  }

  try{
    const res = await fetch('/api/create-cash-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission })
    });
    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`Cash order error (${res.status}): ${t || 'Failed to create order'}`);
    }
    const data = await res.json().catch(()=> ({}));

    // Lightweight confirmation
    alert('✅ Order recorded as Cash/Check. You can assign it in the ProCan dashboard.');

    // Reset flow to start (so prospecting is fast)
    try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
    try{ localStorage.removeItem(FINAL_KEY); }catch(e){}
    window.location.href = './procan-intake.html';
    return data;
  } finally {
    if (btn){
      btn.disabled = false;
      btn.textContent = oldText || 'Confirm';
    }
  }
}

// ===== Events =====
function bind(){
    document.querySelectorAll('[data-cadence]').forEach(btn => {
    btn.addEventListener('click', () => { setAutosaveEnabled(); setCadence(btn.dataset.cadence); });
  });
  document.querySelectorAll('[data-bill]').forEach(btn => {
    btn.addEventListener('click', () => { setAutosaveEnabled(); setBilling(btn.dataset.bill); });
  });

  document.querySelectorAll('[data-pay]').forEach(btn => {
    btn.addEventListener('click', () => { setAutosaveEnabled(); setPaymentMethod(btn.dataset.pay); });
  });

  [
    els.bizName, els.contactName, els.phone, els.email, els.address,
    els.canQty, els.locations, els.serviceDay,
    els.padAddon, els.padSize, els.padCadence,
    els.deepClean, els.deepLevel, els.deepApplies, els.deepQty,
    els.notes, els.startDate, els.oneTimeOnly, els.depositToggle
  ].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => {
      setAutosaveEnabled();
      // Don't let discount typing auto-skip Step 2
      if (els.discountCode && el === els.discountCode) { update(); return; }
      uiState.suppressAutoAdvance = false;
      update();
      scheduleAutoAdvance();
    });
    el.addEventListener('change', () => {
      setAutosaveEnabled();
      if (els.discountCode && el === els.discountCode) { update(); return; }
      uiState.suppressAutoAdvance = false;
      update();
      scheduleAutoAdvance();
    });
  });


  // Step 2: mark "confirmed" ONLY on meaningful interactions (not discount typing)
  const markStep2Confirmed = () => {
    if (uiState.step === 2) uiState.step2Confirmed = true;
  };
  // Billing option buttons
  document.querySelectorAll('[data-bill]').forEach(btn => {
    btn.addEventListener('click', () => { setAutosaveEnabled(); markStep2Confirmed(); uiState.suppressAutoAdvance = false; scheduleAutoAdvance(); });
  });
  // Start date + one-time toggle
  if (els.startDate) els.startDate.addEventListener('change', () => { setAutosaveEnabled(); markStep2Confirmed(); uiState.suppressAutoAdvance = false; scheduleAutoAdvance(); });
  if (els.oneTimeOnly) els.oneTimeOnly.addEventListener('change', () => {
    setAutosaveEnabled();
    markStep2Confirmed();
    uiState.suppressAutoAdvance = false;
    syncPaymentVisibility();
    scheduleAutoAdvance();
  });

  if (els.depositToggle) els.depositToggle.addEventListener('change', () => {
    setAutosaveEnabled();
    markStep2Confirmed();
    uiState.suppressAutoAdvance = false;
    syncPaymentVisibility();
    update();
    scheduleAutoAdvance();
  });

// Discount code (optional)
  if (els.applyDiscount && els.discountCode){
    els.applyDiscount.addEventListener('click', () => {
      setAutosaveEnabled();
      applyDiscountCode(els.discountCode.value);
      update();
      saveDraft();
});
    if (els.removeDiscount){
      els.removeDiscount.addEventListener('click', () => {
        setAutosaveEnabled();
        if (els.discountCode) els.discountCode.value = '';
        applyDiscountCode('');
        update();
        saveDraft();
      });
    }
    els.discountCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter'){ e.preventDefault(); els.applyDiscount.click(); }
    });
  }

els.next1.addEventListener('click', () => {
    attemptedNext1 = true;
    update();
    if (validateStep1().length === 0) transitionToStep(2, 'Finalizing submission…', () => setStep(2));
  });

  els.back2.addEventListener('click', () => transitionToStep(1, 'Returning…', () => setStep(1)));
  els.next2.addEventListener('click', () => {
    attemptedNext2 = true;
    update();
    if (validateStep1().length === 0 && validateStep2().length === 0) transitionToStep(3, 'Generating review…', () => setStep(3));
  });
  els.back3.addEventListener('click', () => transitionToStep(2, 'Returning…', () => setStep(2)));

  els.saveAndContinue.addEventListener('click', () => {
    if (!els.agreeTerms || !els.agreeTerms.checked){
      alert('Please agree to the Terms & Conditions to continue.');
      return;
    }
    const q = computeQuote();
    if (!q.ok) return alert(q.error || 'Fix inputs.');
    attemptedNext1 = true;
    attemptedNext2 = true;
    update();

    const step1Errs = validateStep1();
    const step2Errs = validateStep2();
    if (step1Errs.length || step2Errs.length){
      return alert('Please fix missing fields before saving.');
    }
    const payload = buildSubmission(q);
    localStorage.setItem(FINAL_KEY, JSON.stringify(payload));
    if (payload?.billing?.paymentMethod === 'cash'){
      startCashOrder(payload).catch((err)=>{ alert(err && err.message ? err.message : 'Cash order failed.'); });
    } else {
      startStripeCheckout(payload).catch((err)=>{ alert(err && err.message ? err.message : 'Payment checkout failed.'); });
    }

  });

  if (els.agreeTerms){
    els.agreeTerms.addEventListener('change', () => {
      updateConfirmGate();
    });
  }
}

function init(){
  const today = new Date().toISOString().split('T')[0];
  els.startDate.value = today;

  bindMenu();
  bind();

  if (els.discountCode){ applyDiscountCode(els.discountCode.value, { silent:true }); }

  setCadence(uiState.cadence, { silent:true });
  setBilling(uiState.billing, { silent:true });
  setStep(1, { silent:true });
  uiState.hideSummary = true;
  uiState.step2Confirmed = false;
  applySummaryVisibility();
  update({ silent:true });
}

// ===== Menu =====
function toggleMenu(open){
  const isOpen = els.menu.classList.contains('open');
  const next = (open === undefined) ? !isOpen : !!open;
  els.menu.classList.toggle('open', next);
  els.menu.setAttribute('aria-hidden', next ? 'false' : 'true');
}
function bindMenu(){
  els.btnMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', () => toggleMenu(false));
  els.menu.addEventListener('click', (e) => e.stopPropagation());

  els.btnToggleSummary.addEventListener('click', () => {
    // Allow toggle on any page before final. Final always shows.
    if (uiState.step === 3) return;
    uiState.hideSummary = !uiState.hideSummary;
    applySummaryVisibility();
    toggleMenu(false);
    saveDraft();
  });
  els.btnLoadDraft.addEventListener('click', () => { toggleMenu(false); loadDraft(); });
  els.btnWipeDraft.addEventListener('click', () => { toggleMenu(false); wipeDraft(); });
}

init();
