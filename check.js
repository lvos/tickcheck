const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

const TARGET_URL = "https://tuboleto.cultura.pe/llaqta_machupicchu";

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

async function clickNearLabel(page, labelRegex, description) {
  const label = page.getByText(labelRegex).first();
  await label.waitFor({ state: "visible", timeout: 15000 });

  const box = await label.boundingBox();
  if (!box) throw new Error(`Could not get label box for ${description}`);

  // Click the form input/dropdown below the label.
  await page.mouse.click(box.x + 250, box.y + 45);
  await page.waitForTimeout(1200);
  console.log(`Opened ${description}`);
}

async function clickOption(page, optionRegex, description) {
  const option = page.getByText(optionRegex).first();
  await option.waitFor({ state: "visible", timeout: 15000 });
  await option.click();
  await page.waitForTimeout(1500);
  console.log(`Selected ${description}`);
}

async function clickCalendarDay(page, dayText) {
  // Try an exact visible day button first.
  const exactDay = page.getByText(new RegExp(`^${dayText}$`)).first();
  await exactDay.waitFor({ state: "visible", timeout: 15000 });
  await exactDay.click();
  await page.waitForTimeout(1500);
  console.log(`Selected day ${dayText}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    locale: "es-PE"
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 60000 });
    await page.screenshot({ path: "debug-01-loaded.png", fullPage: true });

    await clickNearLabel(page, /Selecciona el circuito que deseas visitar/i, "circuit dropdown");
    await page.screenshot({ path: "debug-02-circuit-open.png", fullPage: true });

    await clickOption(page, /Circuito 3.*Machupicchu realeza/i, "Circuit 3");
    await page.screenshot({ path: "debug-03-circuit-selected.png", fullPage: true });

    await clickNearLabel(page, /Seleccionar la ruta de tu recorrido/i, "route dropdown");
    await page.screenshot({ path: "debug-04-route-open.png", fullPage: true });

    await clickOption(page, /3A|3-A|Waynapicchu|Huayna/i, "Route 3A / Waynapicchu");
    await page.screenshot({ path: "debug-05-route-selected.png", fullPage: true });

    await clickNearLabel(page, /Selecciona la fecha de tu visita/i, "date picker");
    await page.screenshot({ path: "debug-06-calendar-open.png", fullPage: true });

    // If the calendar opens on the wrong month, this may need an extra "next month" click.
    await clickCalendarDay(page, "30");
    await page.screenshot({ path: "debug-07-date-selected.png", fullPage: true });

    const bodyText = await page.locator("body").innerText({ timeout: 30000 });

    console.log("Final page text sample:");
    console.log(bodyText.slice(0, 5000));

    const hasRoute = /3A|3-A|Waynapicchu|Huayna/i.test(bodyText);
    const soldOut = /agotado|no disponible|sin disponibilidad|0\s*cupos/i.test(bodyText);
    const hasAvailabilitySignal = /cupos|disponible|horario de ingreso|S\/\./i.test(bodyText);

    const likelyAvailable = hasRoute && hasAvailabilitySignal && !soldOut;

    console.log({ hasRoute, hasAvailabilitySignal, soldOut, likelyAvailable });

    if (likelyAvailable) {
      await sendEmail(
        "Machu Picchu 3A ticket may be available for July 30",
        [
          "The automated checker found signs that a 3A / Waynapicchu ticket may be available for July 30.",
          "",
          `Check immediately: ${TARGET_URL}`,
          "",
          "This is an automated check. Please confirm on the official site."
        ].join("\n")
      );

      console.log("Availability signal found. Email sent.");
    } else {
      console.log("No availability signal found.");
    }
  } catch (error) {
    console.error("Checker failed:", error);

    await page.screenshot({ path: "debug-error.png", fullPage: true }).catch(() => {});

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