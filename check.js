const { chromium } = require("playwright");
const fs = require("fs/promises");
const nodemailer = require("nodemailer");

const TARGET_URL = "https://tuboleto.cultura.pe/llaqta_machupicchu";
const TARGET_MONTH = 6; // July, zero-based for JS Date.
const TARGET_DAY = 30;
const PAGE_TIMEOUT_MS = readPositiveIntEnv("PAGE_TIMEOUT_MS", 120000);
const FORM_READY_TIMEOUT_MS = readPositiveIntEnv("FORM_READY_TIMEOUT_MS", 300000);
const ACTION_TIMEOUT_MS = readPositiveIntEnv("ACTION_TIMEOUT_MS", 30000);
const PAGE_LOAD_ATTEMPTS = readPositiveIntEnv("PAGE_LOAD_ATTEMPTS", 3);
const PAGE_LOAD_RETRY_DELAY_MS = readPositiveIntEnv("PAGE_LOAD_RETRY_DELAY_MS", 10000);
const FAILURE_SUBJECT_PATH = "failure-email-subject.txt";
const FAILURE_BODY_PATH = "failure-email-body.txt";

const LABELS = {
  circuit: /Selecciona\s+(?:el|tu)\s+circuito|circuito\s+que\s+deseas\s+visitar/i,
  route: /Selecciona(?:r)?\s+la\s+ruta|ruta\s+de\s+tu\s+recorrido|ruta\s+que\s+desea\s+visitar/i,
  date: /Selecciona\s+la\s+fecha\s+de\s+tu\s+visita/i,
  time: /Selecciona\s+el\s+horario\s+de\s+ingreso/i
};

const TARGET_ROUTES = [
  {
    code: "3A",
    circuitPattern: /Circuito\s*3|Machupicchu\s+realeza|realeza/i,
    routePattern: /\b(?:Ruta\s*)?3\s*[-\s]?\s*A\b|Wayna(?:picchu)?|Huayna(?:picchu)?/i,
    onlyBefore10: false
  },
  {
    code: "2A",
    circuitPattern: /Circuito\s*2|Circuito\s+cl[aá]sico|cl[aá]sico/i,
    routePattern: /\b(?:Ruta\s*)?2\s*[-\s]?\s*A\b|cl[aá]sico\s+dise(?:ñ|n)ada/i,
    onlyBefore10: false
  },
  {
    code: "2B",
    circuitPattern: /Circuito\s*2|Circuito\s+cl[aá]sico|cl[aá]sico/i,
    routePattern: /\b(?:Ruta\s*)?2\s*[-\s]?\s*B\b|terraza\s+inferior/i,
    onlyBefore10: false
  },
  {
    code: "3B",
    circuitPattern: /Circuito\s*3|Machupicchu\s+realeza|realeza/i,
    routePattern: /\b(?:Ruta\s*)?3\s*[-\s]?\s*B\b|realeza\s+dise(?:ñ|n)ada/i,
    onlyBefore10: true
  },
  {
    code: "3D",
    circuitPattern: /Circuito\s*3|Machupicchu\s+realeza|realeza/i,
    routePattern: /\b(?:Ruta\s*)?3\s*[-\s]?\s*D\b|Huchuy(?:picchu)?/i,
    onlyBefore10: true
  }
];

const NONESSENTIAL_RESOURCE_PATTERNS = [
  /checkout\.izipay\.pe/i,
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /captcha-assets\/widget\.js/i
];

const MONTH_NAMES = [
  ["ene", "enero", "jan", "january"],
  ["feb", "febr", "febrero", "february"],
  ["mar", "marzo", "march"],
  ["abr", "abril", "apr", "april"],
  ["may", "mayo"],
  ["jun", "junio", "june"],
  ["jul", "julio", "july"],
  ["ago", "agosto", "aug", "august"],
  ["set", "sep", "sept", "septiembre", "september"],
  ["oct", "octubre", "october"],
  ["nov", "noviembre", "november"],
  ["dic", "diciembre", "dec", "december"]
];

function readPositiveIntEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function getTargetYear() {
  if (process.env.TARGET_YEAR) {
    const parsed = Number(process.env.TARGET_YEAR);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 9999) {
      throw new Error(`Invalid TARGET_YEAR: ${process.env.TARGET_YEAR}`);
    }
    return parsed;
  }

  const now = new Date();
  const thisYearTarget = new Date(now.getFullYear(), TARGET_MONTH, TARGET_DAY, 23, 59, 59);
  return now <= thisYearTarget ? now.getFullYear() : now.getFullYear() + 1;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function regexMatches(regex, value) {
  const text = String(value || "");
  regex.lastIndex = 0;
  if (regex.test(text)) return true;

  regex.lastIndex = 0;
  return regex.test(normalizeText(text));
}

function describeTargetDate(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatDateForEmail(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function routeSlug(routeCode) {
  return routeCode.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function setStep(state, step) {
  state.lastStep = step;
  const route = state.lastRoute ? ` [${state.lastRoute}]` : "";
  console.log(`${new Date().toISOString()}${route} ${step}`);
}

async function sendEmail(subject, body) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "ALERT_TO"];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.log(`Email secrets are not fully set (${missing.join(", ")} missing). No email was sent.`);
    return;
  }

  const port = Number(process.env.SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.ALERT_TO,
    subject,
    text: body
  });

  console.log(`Email sent: ${subject}`);
}

async function writeFailureReport(subject, body) {
  await fs.writeFile(FAILURE_SUBJECT_PATH, `${subject}\n`, "utf8");
  await fs.writeFile(FAILURE_BODY_PATH, body, "utf8");
  console.log(`Wrote failure report files: ${FAILURE_SUBJECT_PATH}, ${FAILURE_BODY_PATH}`);
}

async function takeScreenshot(page, state, label) {
  const routePart = state.lastRoute ? `${routeSlug(state.lastRoute)}-` : "";
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  const sequence = String(++state.screenshotIndex).padStart(3, "0");
  const path = `debug-${sequence}-${routePart}${safeLabel}.png`;

  try {
    await page.screenshot({ path, fullPage: true });
    console.log(`Saved screenshot: ${path}`);
  } catch (error) {
    console.log(`Could not save screenshot ${path}: ${error.message}`);
  }
}

async function getBookingForm(page) {
  const form = page.locator("app-boletos").first();
  await form.waitFor({ state: "visible", timeout: FORM_READY_TIMEOUT_MS });
  return form;
}

async function installResourceFilters(page) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const shouldAbort = NONESSENTIAL_RESOURCE_PATTERNS.some((pattern) => pattern.test(url));

    if (shouldAbort) {
      console.log(`Skipping nonessential resource: ${url}`);
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function detectBlockOrUnexpectedPage(page, state) {
  const currentUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: ACTION_TIMEOUT_MS }).catch(() => "");
  const bookingFormCount = await page.locator("app-boletos").count().catch(() => 0);
  const visibleBody = normalizeText(bodyText);

  if (/\/login(?:\/|$)/i.test(currentUrl)) {
    throw new Error(`Unexpected redirect to login page: ${currentUrl}`);
  }

  const blockSignal =
    /forbidden|access denied|acceso denegado|bloquead|blocked|verify you are human|verifica que no eres un robot|robot|captcha|challenge/i.test(
      visibleBody
    );

  if (blockSignal && bookingFormCount === 0) {
    throw new Error(`The site appears to have blocked or challenged the browser. Current URL: ${currentUrl}`);
  }

  if (bookingFormCount === 0 && /404|pagina no pudo ser encontrada|p[aá]gina no pudo ser encontrada/i.test(visibleBody)) {
    throw new Error(`The ticket page was not found. Current URL: ${currentUrl}`);
  }
}

async function waitForOverlayOptions(page) {
  await page
    .locator(".cdk-overlay-container mat-option")
    .first()
    .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
}

async function findFormFieldByLabel(form, labelRegex, description) {
  const field = form.locator("mat-form-field").filter({ hasText: labelRegex }).first();
  await field.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });

  const count = await field.count();
  if (count === 0) {
    throw new Error(`Could not find form field for ${description}`);
  }

  return field;
}

async function openLabeledDropdown(page, form, labelRegex, description, state) {
  setStep(state, `Opening ${description} dropdown`);
  const field = await findFormFieldByLabel(form, labelRegex, description);
  const select = field.locator("mat-select").first();
  await select.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  await select.click();
  await waitForOverlayOptions(page);
  console.log(`Opened ${description} dropdown`);
  return select;
}

async function selectDropdownOptionByRegex(page, optionRegex, description, { allowDisabled = false } = {}) {
  const options = page.locator(".cdk-overlay-container mat-option");
  await waitForOverlayOptions(page);

  const count = await options.count();
  const optionTexts = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText()).replace(/\s+/g, " ").trim();
    const ariaDisabled = await option.getAttribute("aria-disabled");
    const className = (await option.getAttribute("class")) || "";
    const disabled = ariaDisabled === "true" || /\bdisabled\b|mat-mdc-option-disabled|mdc-list-item--disabled/.test(className);
    optionTexts.push(`${disabled ? "[disabled] " : ""}${text}`);

    if (regexMatches(optionRegex, text)) {
      if (disabled && !allowDisabled) {
        throw new Error(`Matched ${description}, but the option is disabled: ${text}`);
      }

      await option.scrollIntoViewIfNeeded();
      await option.click();
      console.log(`Selected ${description}: ${text}`);
      await page.waitForTimeout(500);
      return text;
    }
  }

  throw new Error(`Could not find option for ${description}. Visible options: ${optionTexts.join(" | ")}`);
}

function parseCalendarHeader(text) {
  const normalized = normalizeText(text).replace(/\./g, "");
  const yearMatch = normalized.match(/\b(20\d{2}|19\d{2})\b/);
  if (!yearMatch) return null;

  const year = Number(yearMatch[1]);
  const month = MONTH_NAMES.findIndex((names) => names.some((name) => new RegExp(`\\b${name}\\b`, "i").test(normalized)));

  return month >= 0 ? { month, year } : null;
}

async function getCalendarMonthYear(page) {
  const header = page.locator(".mat-datepicker-content .mat-calendar-period-button").first();
  await header.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  const text = await header.innerText();
  const parsed = parseCalendarHeader(text);

  if (!parsed) {
    throw new Error(`Could not parse calendar month header: "${text}"`);
  }

  return parsed;
}

function monthDistance(from, to) {
  return (to.year - from.year) * 12 + (to.month - from.month);
}

async function waitForRequestDuring(page, description, predicate, action) {
  const responsePromise = page
    .waitForResponse(predicate, { timeout: 15000 })
    .catch(() => null);

  await action();
  const response = await responsePromise;
  if (response) {
    console.log(`${description} request completed with status ${response.status()}`);
  } else {
    console.log(`No ${description} request observed after this action; continuing with visible UI state.`);
  }
}

async function waitForAvailabilityRequest(page, action) {
  await waitForRequestDuring(
    page,
    "Availability",
    (response) => response.url().includes("/visita/consulta-fechas-disponibles") && response.request().method() === "POST",
    action
  );
}

async function waitForScheduleRequest(page, action) {
  await waitForRequestDuring(
    page,
    "Schedule",
    (response) => response.url().includes("/visita/consulta-horarios") && response.request().method() === "POST",
    action
  );
}

async function navigateCalendarToTargetMonth(page, targetDate) {
  const target = { month: targetDate.getMonth(), year: targetDate.getFullYear() };

  for (let attempt = 0; attempt < 36; attempt += 1) {
    const current = await getCalendarMonthYear(page);
    const distance = monthDistance(current, target);

    if (distance === 0) {
      console.log(`Calendar is showing target month ${target.month + 1}/${target.year}`);
      return;
    }

    const buttonSelector = distance > 0 ? ".mat-calendar-next-button" : ".mat-calendar-previous-button";
    const direction = distance > 0 ? "next" : "previous";
    const button = page.locator(`.mat-datepicker-content ${buttonSelector}`).first();

    await button.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    const disabled = (await button.getAttribute("disabled")) !== null || (await button.getAttribute("aria-disabled")) === "true";
    if (disabled) {
      throw new Error(`Calendar ${direction} button is disabled before reaching target month`);
    }

    console.log(`Calendar is at ${current.month + 1}/${current.year}; clicking ${direction}`);
    await waitForAvailabilityRequest(page, async () => {
      await button.click();
    });
    await page.waitForTimeout(800);
  }

  throw new Error(`Could not navigate calendar to ${target.month + 1}/${target.year}`);
}

function ariaLooksLikeTargetDate(ariaLabel, targetDate) {
  const normalized = normalizeText(ariaLabel);
  if (!normalized) return false;

  const day = targetDate.getDate();
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth();
  const hasDay = new RegExp(`\\b${day}\\b`).test(normalized);
  const hasYear = new RegExp(`\\b${year}\\b`).test(normalized);
  const hasMonth = MONTH_NAMES[month].some((name) => new RegExp(`\\b${name}\\b`, "i").test(normalized));

  return hasDay && hasYear && hasMonth;
}

async function getCalendarDayCandidates(page, targetDate) {
  const day = String(targetDate.getDate());
  const buttons = page.locator(".mat-datepicker-content button.mat-calendar-body-cell");
  const count = await buttons.count();
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = (await button.innerText()).replace(/\s+/g, " ").trim();
    const ariaLabel = (await button.getAttribute("aria-label")) || "";
    const className = (await button.getAttribute("class")) || "";
    const ariaDisabled = await button.getAttribute("aria-disabled");
    const htmlDisabled = (await button.getAttribute("disabled")) !== null;
    const disabled = ariaDisabled === "true" || htmlDisabled || /mat-calendar-body-disabled/.test(className);

    if (text === day && ariaLooksLikeTargetDate(ariaLabel, targetDate)) {
      candidates.push({ index, text, ariaLabel, disabled });
    }
  }

  return { buttons, candidates };
}

async function clickDateField(page, form, state) {
  setStep(state, "Opening date picker");
  const dateField = await findFormFieldByLabel(form, LABELS.date, "date picker");
  const input = dateField.locator("input").first();
  await input.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });

  const isOpen = await page.locator(".mat-datepicker-content mat-calendar").isVisible().catch(() => false);
  if (!isOpen) {
    await input.click();
  }

  await page.locator(".mat-datepicker-content mat-calendar").waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
}

async function selectTargetDate(page, form, targetDate, state) {
  await clickDateField(page, form, state);
  await takeScreenshot(page, state, "date-picker-open");

  await navigateCalendarToTargetMonth(page, targetDate);
  await page.waitForTimeout(1200);
  await takeScreenshot(page, state, "target-month-open");

  const { buttons, candidates } = await getCalendarDayCandidates(page, targetDate);

  if (candidates.length === 0) {
    throw new Error(`Could not find ${describeTargetDate(targetDate)} in the date picker`);
  }

  const target = candidates[0];
  if (target.disabled) {
    console.log(`${describeTargetDate(targetDate)} is visible but not selectable for this route. Treating as no availability.`);
    await takeScreenshot(page, state, "target-date-not-selectable");
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }

  setStep(state, `Selecting target date ${describeTargetDate(targetDate)}`);
  await waitForScheduleRequest(page, async () => {
    await buttons.nth(target.index).click();
  });
  await page.waitForTimeout(1200);
  await takeScreenshot(page, state, "target-date-selected");
  return true;
}

function parseTimeString(value) {
  const text = normalizeText(value);
  const match = text.match(/\b(\d{1,2})(?::|\s*h\s*)?(\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?\b/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].replace(/\./g, "").replace(/\s+/g, "") : "";

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 24 || minute > 59) {
    return null;
  }

  if (/pm/i.test(meridiem) && hour < 12) hour += 12;
  if (/am/i.test(meridiem) && hour === 12) hour = 0;

  if (hour === 24 && minute === 0) hour = 0;
  if (hour > 23) return null;

  return { hour, minute, minutesSinceMidnight: hour * 60 + minute };
}

function isBefore10AM(value) {
  const parsed = typeof value === "string" ? parseTimeString(value) : value;
  return parsed ? parsed.minutesSinceMidnight < 10 * 60 : false;
}

async function readVisibleAvailableTimes(page, form, state) {
  setStep(state, "Reading visible available entry times");

  const timeFieldCount = await form.locator("mat-form-field").filter({ hasText: LABELS.time }).count();
  if (timeFieldCount === 0) {
    console.log("The time dropdown is not visible after selecting the date. Treating as no availability.");
    await takeScreenshot(page, state, "time-dropdown-not-visible");
    return [];
  }

  await openLabeledDropdown(page, form, LABELS.time, "time", state);
  await takeScreenshot(page, state, "time-dropdown-open");

  const options = page.locator(".cdk-overlay-container mat-option");
  const count = await options.count();
  const availableTimes = [];
  const rawOptions = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText()).replace(/\s+/g, " ").trim();
    const ariaDisabled = await option.getAttribute("aria-disabled");
    const className = (await option.getAttribute("class")) || "";
    const disabled = ariaDisabled === "true" || /\bdisabled\b|mat-mdc-option-disabled|mdc-list-item--disabled/.test(className);
    const soldOutText = /agotado|no\s+disponible/i.test(text);
    const parsed = parseTimeString(text);
    rawOptions.push(`${disabled ? "[disabled] " : ""}${text}`);

    if (!disabled && !soldOutText && parsed) {
      availableTimes.push({
        time: `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
        rawText: text,
        parsed
      });
    }
  }

  console.log(`Visible time options: ${rawOptions.length ? rawOptions.join(" | ") : "(none)"}`);
  console.log(
    `Available enabled time options: ${
      availableTimes.length ? availableTimes.map((slot) => `${slot.time} (${slot.rawText})`).join(", ") : "(none)"
    }`
  );

  await page.keyboard.press("Escape").catch(() => {});
  await takeScreenshot(page, state, "time-slots-read");
  return availableTimes;
}

async function loadTicketPage(page, state) {
  let lastError;

  for (let attempt = 1; attempt <= PAGE_LOAD_ATTEMPTS; attempt += 1) {
    const attemptLabel = PAGE_LOAD_ATTEMPTS > 1 ? ` (attempt ${attempt}/${PAGE_LOAD_ATTEMPTS})` : "";
    setStep(state, `Loading official ticket page${attemptLabel}`);

    try {
      await page.goto(TARGET_URL, { waitUntil: "commit", timeout: PAGE_TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {
        console.log("DOMContentLoaded was slow; continuing because the checker waits for the booking form directly.");
      });
      await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS }).catch(() => {
        console.log("Network did not become fully idle; continuing after DOM and form checks.");
      });
      await detectBlockOrUnexpectedPage(page, state);
      const form = await getBookingForm(page);
      await form.getByText(LABELS.circuit).first().waitFor({ state: "visible", timeout: FORM_READY_TIMEOUT_MS });
      await form.getByText(LABELS.route).first().waitFor({ state: "visible", timeout: FORM_READY_TIMEOUT_MS });
      await form.getByText(LABELS.date).first().waitFor({ state: "visible", timeout: FORM_READY_TIMEOUT_MS });
      await takeScreenshot(page, state, `page-loaded-attempt-${attempt}`);
      return form;
    } catch (error) {
      lastError = error;
      console.log(`Page load attempt ${attempt}/${PAGE_LOAD_ATTEMPTS} failed: ${error.message}`);
      await takeScreenshot(page, state, `page-load-attempt-${attempt}-failed`);

      if (attempt >= PAGE_LOAD_ATTEMPTS) {
        throw lastError;
      }

      console.log(`Retrying page load in ${PAGE_LOAD_RETRY_DELAY_MS}ms`);
      await page.waitForTimeout(PAGE_LOAD_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function checkRoute(browser, route, targetDate, state) {
  state.lastRoute = route.code;
  setStep(state, `Starting route ${route.code}`);

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    locale: "es-PE",
    timezoneId: "America/Lima"
  });

  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await installResourceFilters(page);

  page.on("console", (message) => {
    const text = message.text();
    if (/error|warn|fecha|horario|ruta|circuito/i.test(text)) {
      console.log(`[browser:${message.type()}] ${text}`);
    }
  });

  page.on("pageerror", (error) => {
    console.log(`[browser:pageerror] ${error.message}`);
  });

  try {
    const form = await loadTicketPage(page, state);

    await openLabeledDropdown(page, form, LABELS.circuit, "circuit", state);
    await takeScreenshot(page, state, "circuit-dropdown-open");
    setStep(state, `Selecting circuit for route ${route.code}`);
    await selectDropdownOptionByRegex(page, route.circuitPattern, `circuit for route ${route.code}`);
    await page.waitForTimeout(800);
    await takeScreenshot(page, state, "circuit-selected");

    await openLabeledDropdown(page, form, LABELS.route, "route", state);
    await takeScreenshot(page, state, "route-dropdown-open");
    setStep(state, `Selecting route ${route.code}`);
    await selectDropdownOptionByRegex(page, route.routePattern, `route ${route.code}`);
    await page.waitForTimeout(1500);
    await takeScreenshot(page, state, "route-selected");

    const dateSelected = await selectTargetDate(page, form, targetDate, state);
    if (!dateSelected) {
      return [];
    }

    const availableTimes = await readVisibleAvailableTimes(page, form, state);
    const matchingTimes = availableTimes.filter((slot) => !route.onlyBefore10 || isBefore10AM(slot.parsed));

    if (route.onlyBefore10) {
      const skipped = availableTimes.filter((slot) => !isBefore10AM(slot.parsed));
      if (skipped.length > 0) {
        console.log(
          `Route ${route.code}: ignoring times at/after 10:00 AM: ${skipped.map((slot) => slot.time).join(", ")}`
        );
      }
    }

    if (matchingTimes.length === 0) {
      console.log(`Route ${route.code}: no matching availability found for ${describeTargetDate(targetDate)}.`);
      return [];
    }

    console.log(
      `Route ${route.code}: matching availability found: ${matchingTimes.map((slot) => slot.time).join(", ")}`
    );

    return matchingTimes.map((slot) => ({
      route: route.code,
      time: slot.time,
      rawText: slot.rawText
    }));
  } catch (error) {
    await takeScreenshot(page, state, "error");
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

function buildAvailabilityEmail(matches, targetDate) {
  const lines = [
    `Machu Picchu ticket availability was found for ${describeTargetDate(targetDate)} (${formatDateForEmail(targetDate)}).`,
    "",
    "Matching options:"
  ];

  for (const match of matches) {
    lines.push(`- Route ${match.route}: ${match.time} (${match.rawText})`);
  }

  lines.push("", `Official ticket URL: ${TARGET_URL}`, "", "This checker only reports enabled time-slot options after selecting the target route and date on the official site.");
  return lines.join("\n");
}

function formatTimeForSubject(time) {
  return String(time || "").replace(/^0(?=\d:)/, "");
}

function routeTimesForSubject(matches) {
  const timesByRoute = new Map();

  for (const match of matches) {
    const times = timesByRoute.get(match.route) || new Set();
    times.add(formatTimeForSubject(match.time));
    timesByRoute.set(match.route, times);
  }

  return TARGET_ROUTES.filter((route) => timesByRoute.has(route.code))
    .map((route) => `${route.code} [${[...timesByRoute.get(route.code)].join(", ")}]`)
    .join(", ");
}

function monitoredRouteCodesForSubject() {
  return TARGET_ROUTES.map((route) => route.code).join(", ");
}

function buildAvailabilitySubject(matches, targetDate) {
  return `Machu Picchu (${routeTimesForSubject(matches)}) tickets available for ${formatDateForEmail(targetDate)}`;
}

function buildFailureSubject() {
  return `Machu Picchu (${monitoredRouteCodesForSubject()}) ticket checker failed`;
}

function buildFailureEmail(error, state, targetDate) {
  return [
    `The Machu Picchu ticket checker failed for ${describeTargetDate(targetDate)} (${formatDateForEmail(targetDate)}).`,
    "",
    `Last route being checked: ${state.lastRoute || "none"}`,
    `Last step reached: ${state.lastStep || "none"}`,
    "",
    `Error message: ${error.message || String(error)}`,
    "",
    "Stack trace:",
    error.stack || "(no stack trace available)",
    "",
    `Official ticket URL: ${TARGET_URL}`
  ].join("\n");
}

async function main() {
  const state = {
    lastRoute: "",
    lastStep: "",
    screenshotIndex: 0
  };
  const targetYear = getTargetYear();
  const targetDate = new Date(targetYear, TARGET_MONTH, TARGET_DAY);
  let browser;

  console.log(`Target date: ${describeTargetDate(targetDate)} (${formatDateForEmail(targetDate)})`);
  console.log(`Target routes: ${TARGET_ROUTES.map((route) => route.code).join(", ")}`);
  console.log(`Official URL: ${TARGET_URL}`);
  console.log(
    `Timeouts: page=${PAGE_TIMEOUT_MS}ms, form=${FORM_READY_TIMEOUT_MS}ms, action=${ACTION_TIMEOUT_MS}ms, page load attempts=${PAGE_LOAD_ATTEMPTS}`
  );

  try {
    setStep(state, "Launching Chromium");
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"]
    });

    const matches = [];
    for (const route of TARGET_ROUTES) {
      const routeMatches = await checkRoute(browser, route, targetDate, state);
      matches.push(...routeMatches);
    }

    state.lastRoute = "";
    setStep(state, "Finished all route checks");

    if (matches.length > 0) {
      await sendEmail(
        buildAvailabilitySubject(matches, targetDate),
        buildAvailabilityEmail(matches, targetDate)
      );
      console.log(`Availability email sent with ${matches.length} matching option(s).`);
      return;
    }

    console.log("No matching availability found");
  } catch (error) {
    console.error("Checker failed:", error);

    const failureSubject = buildFailureSubject();
    const failureBody = buildFailureEmail(error, state, targetDate);

    await writeFailureReport(failureSubject, failureBody).catch((writeError) => {
      console.error("Failed to write failure report files:", writeError);
    });

    if (process.env.SEND_FAILURE_EMAIL_IMMEDIATELY === "false") {
      console.log("Immediate failure email disabled; workflow will decide whether the failure streak should alert.");
    } else {
      await sendEmail(failureSubject, failureBody).catch((emailError) => {
        console.error("Failed to send failure email:", emailError);
      });
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main();
