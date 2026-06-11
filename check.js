const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

const TARGET_URL = "https://tuboleto.cultura.pe/llaqta_machupicchu";
const TARGET_DATE_TEXT = "30"; // July 30 day cell
const TARGET_MONTH_TEXT = "Julio";
const TARGET_ROUTE_PATTERNS = [
  /3A/i,
  /Waynapicchu/i,
  /Huayna/i,
  /Huayna Picchu/i
];

async function sendEmail(subject, body) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.ALERT_TO) {
    console.log("Email secrets are not set, so no email was sent.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
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
}

async function main() {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    locale: "es-PE"
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 60000 });

    // Helps when debugging from GitHub Actions artifacts.
    await page.screenshot({ path: "debug.png", fullPage: true });

    // ----- IMPORTANT -----
    // The exact selectors below may need adjustment after you inspect the site.
    // This script first searches the rendered page text for route/date/availability clues.
    // Once you record the exact booking steps, replace this block with exact clicks.

    const bodyText = await page.locator("body").innerText({ timeout: 30000 });

    console.log("Page loaded. Text sample:");
    console.log(bodyText.slice(0, 2000));

    const routeMentioned = TARGET_ROUTE_PATTERNS.some((pattern) => pattern.test(bodyText));
    const soldOutWords = /agotado|no disponible|sin disponibilidad|0\s*cupos/i.test(bodyText);
    const availableWords = /disponible|cupos|entradas/i.test(bodyText);

    // Conservative logic:
    // It only emails if route-like text appears and the page suggests availability,
    // and does not contain obvious sold-out language.
    const likelyAvailable = routeMentioned && availableWords && !soldOutWords;

    if (likelyAvailable) {
      const subject = "Machu Picchu 3A ticket may be available for July 30";
      const body = [
        "The automated checker found signs that a 3A / Waynapicchu ticket may be available for July 30.",
        "",
        `Check immediately: ${TARGET_URL}`,
        "",
        "Note: this is an automated check, so confirm on the official site before relying on it."
      ].join("\n");

      await sendEmail(subject, body);
      console.log("Availability signal found. Email sent.");
    } else {
      console.log("No availability signal found.");
      console.log({
        routeMentioned,
        availableWords,
        soldOutWords
      });
    }
  } catch (error) {
    console.error("Checker failed:", error);

    await sendEmail(
      "Machu Picchu ticket checker failed",
      `The automated checker failed:\n\n${error.stack || error.message}`
    );

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();