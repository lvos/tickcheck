const fs = require("fs/promises");
const nodemailer = require("nodemailer");

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const FAILURE_BODY_PATH = "failure-email-body.txt";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function workflowFileName() {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF || "";
  const match = workflowRef.match(/\.github\/workflows\/([^@]+)@/);
  return match ? match[1] : "check.yml";
}

function isFailedRun(run) {
  return FAILURE_CONCLUSIONS.has(run.conclusion);
}

function runUrl(run) {
  return run.html_url || `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.id}`;
}

async function fetchPreviousWorkflowRuns() {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const branch = process.env.GITHUB_REF_NAME || "main";
  const currentRunId = Number(requiredEnv("GITHUB_RUN_ID"));
  const workflow = encodeURIComponent(workflowFileName());
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(
    branch
  )}&per_page=10&exclude_pull_requests=true`;

  console.log(`Fetching previous workflow runs from ${url}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requiredEnv("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tickcheck-failure-streak-notifier"
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}: ${body}`);
  }

  const data = JSON.parse(body);
  return (data.workflow_runs || [])
    .filter((run) => Number(run.id) !== currentRunId)
    .filter((run) => run.status === "completed");
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

async function latestFailureBody() {
  try {
    return await fs.readFile(FAILURE_BODY_PATH, "utf8");
  } catch (error) {
    console.log(`Could not read ${FAILURE_BODY_PATH}: ${error.message}`);
    return "(The checker did not produce a failure detail file.)";
  }
}

async function main() {
  const previousRuns = await fetchPreviousWorkflowRuns();
  let priorFailureStreak = 0;

  for (const run of previousRuns) {
    if (!isFailedRun(run)) break;
    priorFailureStreak += 1;
  }

  const currentStreak = priorFailureStreak + 1;
  console.log(`Current failed workflow streak: ${currentStreak}`);

  if (currentStreak !== 3) {
    console.log("No repeated-failure email sent. The alert is sent only when the streak reaches exactly 3.");
    return;
  }

  const currentRunUrl = `${requiredEnv("GITHUB_SERVER_URL")}/${requiredEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredEnv(
    "GITHUB_RUN_ID"
  )}`;
  const priorFailures = previousRuns.slice(0, 2);
  const failureDetails = await latestFailureBody();

  const body = [
    "The past 3 workflow attempts failed.",
    "",
    `Current run: ${currentRunUrl}`,
    "",
    "Previous failed runs:",
    ...priorFailures.map((run) => `- #${run.run_number}: ${run.conclusion} at ${run.created_at} (${runUrl(run)})`),
    "",
    "Latest checker failure details:",
    "",
    failureDetails
  ].join("\n");

  await sendEmail("Machu Picchu checker: past 3 workflow attempts failed", body);
}

main().catch((error) => {
  console.error("Failed to evaluate/send repeated-failure notification:", error);
  process.exitCode = 1;
});
