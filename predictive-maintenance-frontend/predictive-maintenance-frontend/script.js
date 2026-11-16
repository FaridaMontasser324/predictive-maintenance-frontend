/* =========================================================
   Predictive Maintenance System – frontend logic
   Vanilla JavaScript, no dependencies.

   Flow: validate form -> POST the six readings as JSON to the API ->
   unwrap the response -> show the values exactly as returned.
   ========================================================= */
'use strict';

/* ---------------------------------------------------------
   Configuration – the ONLY place the API URL is defined.
   --------------------------------------------------------- */
const CONFIG = Object.freeze({
  API_URL: 'https://aoohc7ytsa.execute-api.eu-north-1.amazonaws.com/predict',
  // API Gateway HTTP APIs time out after 30 s; give up slightly earlier.
  REQUEST_TIMEOUT_MS: 29000,
});

/* The six original model inputs, in the order they are sent. */
const FIELDS = Object.freeze([
  { key: 'type',                  label: 'Machine type',          kind: 'enum',   allowed: ['L', 'M', 'H'] },
  { key: 'air_temperature_k',     label: 'Air temperature',       kind: 'number', unit: 'K' },
  { key: 'process_temperature_k', label: 'Process temperature',   kind: 'number', unit: 'K' },
  { key: 'rotational_speed_rpm',  label: 'Rotational speed',      kind: 'number', unit: 'RPM' },
  { key: 'torque_nm',             label: 'Torque',                kind: 'number', unit: 'Nm' },
  { key: 'tool_wear_min',         label: 'Tool wear',             kind: 'number', unit: 'min' },
]);

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r="52" in index.html

/* ---------------------------------------------------------
   DOM references
   --------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const dom = {
  form: $('predict-form'),
  submitBtn: $('submit-btn'),
  submitLabel: $('submit-label'),
  resetBtn: $('reset-btn'),
  resultCard: $('result-card'),
  resultTitle: $('result-title'),
  errorTitle: $('error-title'),
  errorMessage: $('error-message'),
  successBody: $('result-body'),
  gaugeFill: $('gauge-fill'),
  probabilityValue: $('probability-value'),
  statusBadge: $('status-badge'),
  statusValue: $('status-value'),
  statusIcon: $('status-icon'),
  riskBadge: $('risk-badge'),
  riskValue: $('risk-value'),
  actionBox: document.querySelector('.action-box'),
  actionValue: $('action-value'),
  scaleMarker: $('scale-marker'),
  explainText: $('explain-text'),
  inputsList: $('inputs-list'),
  resultTime: $('result-time'),
};

let isSubmitting = false;

/* ---------------------------------------------------------
   Errors
   --------------------------------------------------------- */
class ApiError extends Error {
  /**
   * @param {string} kind  network | timeout | unavailable | validation |
   *                       not_found | throttled | invalid_response | unknown
   * @param {string} [detail] short technical hint (logged to the console only, never shown to users)
   * @param {string} [backendMessage] message returned by the backend (validation only)
   */
  constructor(kind, detail = '', backendMessage = '') {
    super(kind);
    this.kind = kind;
    this.detail = detail;
    this.backendMessage = backendMessage;
  }
}

const ERROR_COPY = Object.freeze({
  network: {
    title: 'Connection problem',
    message: 'We could not reach the prediction service. Check your internet connection and try again.',
  },
  timeout: {
    title: 'This is taking longer than expected',
    message: 'The prediction did not finish in time. Please try again in a moment.',
  },
  unavailable: {
    title: 'Prediction is temporarily unavailable',
    message: 'The prediction service is not available right now, so no result could be produced. Please try again later.',
  },
  validation: {
    title: 'Please check your input',
    message: 'The readings could not be accepted.',
  },
  not_found: {
    title: 'Something went wrong',
    message: 'The prediction service could not be found. Please try again later.',
  },
  throttled: {
    title: 'Too many requests',
    message: 'Please wait a moment and try again.',
  },
  invalid_response: {
    title: 'Something went wrong',
    message: 'We received an unexpected answer, so no result can be shown. Please try again.',
  },
  unknown: {
    title: 'Prediction failed',
    message: 'Something went wrong while checking your machine. Please try again.',
  },
});

/* ---------------------------------------------------------
   Form reading and validation
   --------------------------------------------------------- */
function fieldWrapper(key) {
  return dom.form.querySelector(`[data-field="${key}"]`);
}

function setFieldError(key, message) {
  const wrapper = fieldWrapper(key);
  const errorEl = $(`${key}-error`);
  const control = $(key);
  if (!wrapper || !errorEl || !control) return;
  wrapper.classList.toggle('invalid', Boolean(message));
  errorEl.textContent = message || '';
  if (message) control.setAttribute('aria-invalid', 'true');
  else control.removeAttribute('aria-invalid');
}

function clearAllFieldErrors() {
  FIELDS.forEach((f) => setFieldError(f.key, ''));
}

/**
 * Reads and validates the six inputs.
 * @returns {{ok: boolean, payload?: object, firstInvalid?: string}}
 */
function readAndValidate() {
  const payload = {};
  let firstInvalid = null;

  for (const field of FIELDS) {
    const control = $(field.key);
    const raw = control.value.trim();
    let error = '';

    if (field.kind === 'enum') {
      if (raw === '') error = 'Select a machine type.';
      else if (!field.allowed.includes(raw)) error = 'Machine type must be L, M or H.';
      else payload[field.key] = raw;
    } else {
      if (raw === '' || (control.validity && control.validity.badInput)) {
        error = raw === '' && !(control.validity && control.validity.badInput)
          ? 'This field is required.'
          : 'Enter a valid number.';
      } else {
        const value = Number(raw);
        if (!Number.isFinite(value)) error = 'Enter a valid number.';
        else if (value < 0) error = 'Value must not be negative.';
        else payload[field.key] = value; // sent as a JSON number, not a string
      }
    }

    setFieldError(field.key, error);
    if (error && !firstInvalid) firstInvalid = field.key;
  }

  return firstInvalid ? { ok: false, firstInvalid } : { ok: true, payload };
}

/* ---------------------------------------------------------
   API call and response handling
   --------------------------------------------------------- */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function tryParseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (_) { return { ok: false, value: null }; }
}

/**
 * Handles both response shapes:
 *  1. API Gateway proxy integration already unwrapped it:
 *       {"success":true,"data":{...},"error":null}
 *  2. The Lambda envelope arrives as-is, with a JSON *string* body:
 *       {"statusCode":200,"headers":{...},"body":"{\"success\":true,...}"}
 * Returns the effective HTTP status and the inner application payload.
 */
function unwrapResponse(parsed, httpStatus) {
  let status = httpStatus;
  let payload = parsed;

  if (isObject(parsed) && 'body' in parsed && ('statusCode' in parsed || typeof parsed.body === 'string')) {
    if (Number.isInteger(parsed.statusCode)) status = parsed.statusCode;
    payload = parsed.body;
  }

  if (typeof payload === 'string') {
    const inner = tryParseJson(payload);
    payload = inner.ok ? inner.value : null;
  }

  return { status, payload };
}

const UNAVAILABLE_HINT = /endpoint|sagemaker|could not be found|not found|model|unavailable|timed? ?out|throttl|service error|internal/i;

function shortText(value, max = 200) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Validates the prediction object so a malformed reply is never shown as a result. */
function normalizePrediction(data) {
  if (!isObject(data)) throw new ApiError('invalid_response', 'Missing prediction data');

  const probability = data.failure_probability;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new ApiError('invalid_response', 'Invalid failure_probability');
  }
  if (data.prediction !== 0 && data.prediction !== 1) {
    throw new ApiError('invalid_response', 'Invalid prediction value');
  }
  for (const key of ['status', 'risk_level', 'recommended_action']) {
    if (typeof data[key] !== 'string' || data[key] === '') {
      throw new ApiError('invalid_response', `Missing ${key}`);
    }
  }

  return {
    failure_probability: probability,
    prediction: data.prediction,
    status: data.status,
    risk_level: data.risk_level,
    recommended_action: data.recommended_action,
  };
}

async function requestPrediction(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  let httpStatus;
  let text;
  try {
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    httpStatus = response.status;
    text = await response.text();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new ApiError('timeout');
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
  }

  const outer = tryParseJson(text);
  if (!outer.ok) {
    if (httpStatus >= 500) throw new ApiError('unavailable', `HTTP ${httpStatus}`);
    throw new ApiError('invalid_response', `HTTP ${httpStatus}, body is not JSON`);
  }

  const { status, payload: body } = unwrapResponse(outer.value, httpStatus);
  const backendError = isObject(body) && typeof body.error === 'string' ? body.error : '';

  // Application-level success.
  if (isObject(body) && body.success === true && status < 400) {
    return normalizePrediction(body.data);
  }

  // Failures.
  if (status === 404) throw new ApiError('not_found', `HTTP ${status}`);
  if (status === 429) throw new ApiError('throttled', `HTTP ${status}`);
  if (status === 502 || status === 503 || status === 504) throw new ApiError('unavailable', `HTTP ${status}`);

  if (isObject(body) && body.success === false) {
    // Backend input validation errors are client-side problems (4xx). Anything that
    // looks like an infrastructure failure is reported as "unavailable".
    if (status >= 500 || UNAVAILABLE_HINT.test(backendError)) {
      throw new ApiError('unavailable', `HTTP ${status}`);
    }
    throw new ApiError('validation', `HTTP ${status}`, shortText(backendError) || 'Invalid input.');
  }

  if (status >= 500) throw new ApiError('unavailable', `HTTP ${status}`);
  if (status >= 400) throw new ApiError('unknown', `HTTP ${status}`);
  throw new ApiError('invalid_response', `HTTP ${status}`);
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */
function setCardState(state) {
  dom.resultCard.dataset.state = state;
  dom.resultCard.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
}

function setLoading(loading) {
  isSubmitting = loading;
  dom.submitBtn.disabled = loading;
  dom.resetBtn.disabled = loading;
  dom.submitBtn.classList.toggle('is-loading', loading);
  dom.submitBtn.setAttribute('aria-disabled', String(loading));
  dom.submitLabel.textContent = loading ? 'Requesting…' : 'Predict Failure';
  dom.form.querySelectorAll('input, select').forEach((el) => { el.readOnly = loading; });
}

function toneForRisk(risk) {
  switch (String(risk).toUpperCase()) {
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
    default: return 'neutral';
  }
}

function formatPercent(probability) {
  return `${(probability * 100).toFixed(2)}%`;
}

function formatInput(key, value) {
  return key === 'type' ? value : String(value);
}

function renderSuccess(result, payload) {
  const riskTone = toneForRisk(result.risk_level);
  const isFailure = result.prediction === 1;
  const statusTone = isFailure ? 'high' : 'low';

  // Failure probability (percentage + gauge + scale marker).
  dom.probabilityValue.textContent = formatPercent(result.failure_probability);
  const pct = Math.min(Math.max(result.failure_probability, 0), 1);
  dom.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
  dom.scaleMarker.style.left = '0%';
  dom.resultCard.style.setProperty('--accent', `var(--${riskTone === 'neutral' ? 'cyan' : riskTone})`);
  // Next frame so the transition animates from empty.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    dom.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - pct));
    dom.scaleMarker.style.left = `${pct * 100}%`;
  }));

  // Prediction status – shown exactly as returned.
  dom.statusValue.textContent = result.status;
  dom.statusBadge.dataset.tone = statusTone;
  dom.statusIcon.setAttribute('href', isFailure ? '#i-alert' : '#i-check');

  // Risk level – shown exactly as returned, styled separately from status.
  dom.riskValue.textContent = result.risk_level;
  dom.riskBadge.dataset.tone = riskTone;

  // Recommended action – exactly as returned.
  dom.actionValue.textContent = result.recommended_action;
  dom.actionBox.dataset.tone = riskTone === 'neutral' ? statusTone : (isFailure ? 'high' : riskTone);

  dom.explainText.textContent = isFailure
    ? 'A potential machine failure is predicted based on the readings you entered.'
    : 'No failure is predicted based on the readings you entered.';

  // Echo of what was submitted.
  dom.inputsList.replaceChildren();
  FIELDS.forEach((field) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = field.label;
    dd.textContent = field.kind === 'number'
      ? `${formatInput(field.key, payload[field.key])} ${field.unit}`
      : formatInput(field.key, payload[field.key]);
    row.append(dt, dd);
    dom.inputsList.append(row);
  });

  dom.resultTime.textContent = `Checked ${new Date().toLocaleString()}`;

  setCardState('success');
  retriggerAnimation(dom.successBody);
}

function renderError(error) {
  const kind = error instanceof ApiError && ERROR_COPY[error.kind] ? error.kind : 'unknown';
  const copy = ERROR_COPY[kind];

  dom.errorTitle.textContent = copy.title;
  dom.errorMessage.textContent = kind === 'validation' && error.backendMessage
    ? `${copy.message} (${error.backendMessage})`
    : copy.message;
  if (error instanceof ApiError && error.detail) console.warn('Prediction request failed:', error.kind, error.detail);

  setCardState('error');
  retriggerAnimation(document.querySelector('.state-error'));
}

function retriggerAnimation(el) {
  if (!el) return;
  el.classList.remove('is-fresh');
  void el.offsetWidth; // restart CSS animation
  el.classList.add('is-fresh');
}

function focusResult() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  dom.resultCard.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  dom.resultTitle.focus({ preventScroll: true });
}

/* ---------------------------------------------------------
   Event handlers
   --------------------------------------------------------- */
async function handleSubmit(event) {
  event.preventDefault();
  if (isSubmitting) return; // prevent repeated submissions

  const validation = readAndValidate();
  if (!validation.ok) {
    $(validation.firstInvalid).focus();
    return;
  }

  setLoading(true);
  setCardState('loading');
  focusResult();

  try {
    const result = await requestPrediction(validation.payload);
    renderSuccess(result, validation.payload);
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false);
  }
}

function handleReset() {
  if (isSubmitting) return;
  dom.form.reset();
  clearAllFieldErrors();
  setCardState('empty');
  dom.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
  $('type').focus();
}

function handleFieldInput(event) {
  const target = event.target;
  if (target && target.id && FIELDS.some((f) => f.key === target.id)) {
    setFieldError(target.id, '');
  }
}

/* ---------------------------------------------------------
   Navigation: highlight the section currently in view
   --------------------------------------------------------- */
function initNavigation() {
  const links = Array.from(document.querySelectorAll('.nav-link'));
  const sections = links
    .map((link) => document.getElementById(link.dataset.section))
    .filter(Boolean);

  const setActive = (id) => {
    links.forEach((link) => {
      const active = link.dataset.section === id;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };

  setActive('dashboard');
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((e) => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) setActive(visible.target.id);
  }, { rootMargin: '-20% 0px -55% 0px', threshold: [0, 0.15, 0.4] });

  sections.forEach((section) => observer.observe(section));
}

/* ---------------------------------------------------------
   Init – nothing is sent to the backend until the user submits.
   --------------------------------------------------------- */
function init() {
  dom.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
  dom.form.addEventListener('submit', handleSubmit);
  dom.form.addEventListener('input', handleFieldInput);
  dom.form.addEventListener('change', handleFieldInput);
  dom.resetBtn.addEventListener('click', handleReset);
  initNavigation();
}

init();
