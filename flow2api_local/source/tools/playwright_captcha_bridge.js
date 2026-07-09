#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const FLOW2API_WS = process.env.FLOW2API_WS || "ws://127.0.0.1:38000/captcha_ws";
const FLOW2API_KEY = process.env.FLOW2API_KEY || "tengying";
const ROUTE_KEY = process.env.FLOW2API_ROUTE_KEY || "";
const CLIENT_LABEL = process.env.FLOW2API_CLIENT_LABEL || "playwright-bridge";
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
const PROFILE_DIRECTORY = process.env.CHROME_PROFILE_DIRECTORY || "Default";
const CHROME_EXE = process.env.CHROME_EXE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const FLOW_URL = process.env.FLOW_URL || "https://labs.google/fx/tools/flow/project/ec590da0-6e0c-45ae-a3f1-aa09d969966b";
const RECAPTCHA_SITE_KEY = process.env.FLOW2API_RECAPTCHA_SITE_KEY || "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const LOG_FILE = process.env.FLOW2API_BRIDGE_LOG || path.join(process.env.TEMP || process.cwd(), "flow2api_playwright_bridge.log");

const originalLog = console.log.bind(console);
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map(item => {
    if (typeof item === "string") return item;
    try { return JSON.stringify(item); } catch (_) { return String(item); }
  }).join(" ")}`;
  try { fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8"); } catch (_) {}
  originalLog(...args);
};

let browserContext = null;
let flowPage = null;
let launchPromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureBrowser() {
  if (browserContext) return browserContext;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    console.log(`[Playwright Bridge] Launching Chrome profile ${PROFILE_DIRECTORY} from ${USER_DATA_DIR}`);
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      executablePath: CHROME_EXE,
      headless: false,
      ignoreDefaultArgs: [
        "--enable-automation",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-default-apps",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--no-sandbox"
      ],
      args: [
        `--profile-directory=${PROFILE_DIRECTORY}`,
        "--no-first-run",
        "--no-default-browser-check"
      ],
      viewport: null
    });
    browserContext = context;
    context.on("close", () => {
      browserContext = null;
      flowPage = null;
      launchPromise = null;
    });
    return context;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function ensureFlowPage(projectId) {
  const context = await ensureBrowser();
  const projectUrl = projectId
    ? `https://labs.google/fx/tools/flow/project/${projectId}`
    : FLOW_URL;
  const pages = context.pages();
  flowPage = pages.find(page => page.url().startsWith("https://labs.google/fx/tools/flow")) || flowPage;
  if (!flowPage || flowPage.isClosed()) {
    flowPage = await context.newPage();
    await flowPage.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  } else if (projectId && !flowPage.url().includes(`/project/${projectId}`)) {
    await flowPage.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  await flowPage.bringToFront().catch(() => null);
  await flowPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => null);
  return flowPage;
}

async function syncSession(serverWs, projectId) {
  try {
    const page = await ensureFlowPage(projectId);
    await page.waitForTimeout(1500);
    const cookies = await browserContext.cookies("https://labs.google/");
    const direct = [];
    const chunks = new Map();
    for (const cookie of cookies || []) {
      const name = String(cookie.name || "");
      if (!/(next-auth|authjs)\.session-token/i.test(name)) continue;
      const chunkMatch = name.match(/^(.*?session-token)\.(\d+)$/i);
      if (chunkMatch) {
        const key = `${cookie.domain}|${cookie.path}|${chunkMatch[1]}`;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push({ index: Number(chunkMatch[2]), cookie });
      } else if (cookie.value) {
        direct.push({ name, value: cookie.value, length: cookie.value.length });
      }
    }
    for (const group of chunks.values()) {
      const sorted = group.filter(item => item.cookie && item.cookie.value).sort((a, b) => a.index - b.index);
      if (!sorted.length) continue;
      const value = sorted.map(item => item.cookie.value).join("");
      direct.push({ name: sorted[0].cookie.name.replace(/\.\d+$/i, ".*"), value, length: value.length });
    }
    direct.sort((a, b) => b.length - a.length);
    const session = direct[0];
    if (!session || !session.value) {
      const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      console.log(`[Playwright Bridge] No Labs session cookie found. Page text starts: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      return;
    }
    console.log(`[Playwright Bridge] Syncing Google Labs session cookie ${session.name}, len=${session.length}`);
    serverWs.send(JSON.stringify({
      type: "sync_session",
      st: session.value,
      cookie_name: session.name,
      route_key: ROUTE_KEY,
      client_label: CLIENT_LABEL
    }));
  } catch (err) {
    console.log("[Playwright Bridge] Session sync failed:", err.message);
  }
}

async function mintRecaptchaToken(projectId, action) {
  const page = await ensureFlowPage(projectId);
  return await page.evaluate(({ siteKey, actionName }) => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      function run() {
        grecaptcha.enterprise.ready(function() {
          grecaptcha.enterprise.execute(siteKey, { action: actionName || "IMAGE_GENERATION" })
            .then(token => done(resolve, token))
            .catch(err => done(reject, err && err.message ? err.message : "reCAPTCHA evaluation failed"));
        });
      }
      try {
        if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
          run();
        } else {
          const script = document.createElement("script");
          script.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
          script.onload = run;
          script.onerror = () => done(reject, "Failed to load enterprise.js");
          document.head.appendChild(script);
        }
        setTimeout(() => done(reject, "Timeout generating reCAPTCHA locally"), 30000);
      } catch (err) {
        done(reject, err && err.message ? err.message : String(err));
      }
    });
  }, { siteKey: RECAPTCHA_SITE_KEY, actionName: action || "IMAGE_GENERATION" });
}

function connectServer() {
  const url = new URL(FLOW2API_WS);
  if (FLOW2API_KEY) url.searchParams.set("key", FLOW2API_KEY);
  if (ROUTE_KEY) url.searchParams.set("route_key", ROUTE_KEY);
  if (CLIENT_LABEL) url.searchParams.set("client_label", CLIENT_LABEL);

  const ws = new WebSocket(url.toString());

  ws.onopen = () => {
    console.log(`[Playwright Bridge] Connected to ${url.toString()}`);
    ws.send(JSON.stringify({ type: "register", route_key: ROUTE_KEY, client_label: CLIENT_LABEL }));
    syncSession(ws).catch(err => console.log("[Playwright Bridge] Initial sync failed:", err.message));
  };

  ws.onmessage = async event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (data.type === "register_ack") {
      console.log(`[Playwright Bridge] Registered route_key=${data.route_key || "-"} label=${data.client_label || "-"}`);
      return;
    }
    if (data.type === "sync_session_ack") {
      console.log(`[Playwright Bridge] Session sync ok=${Boolean(data.ok)} email=${data.email || "-"} error=${data.error || "-"}`);
      return;
    }
    if (data.type !== "get_token" || !data.req_id) return;
    try {
      console.log(`[Playwright Bridge] Minting token action=${data.action || "IMAGE_GENERATION"} project=${data.project_id || "-"}`);
      const token = await mintRecaptchaToken(data.project_id, data.action || "IMAGE_GENERATION");
      ws.send(JSON.stringify({ req_id: data.req_id, status: "success", token }));
    } catch (err) {
      ws.send(JSON.stringify({ req_id: data.req_id, status: "error", error: err.message }));
    }
  };

  ws.onclose = () => {
    console.log("[Playwright Bridge] Server connection closed; reconnecting in 2s...");
    setTimeout(connectServer, 2000);
  };
  ws.onerror = event => {
    console.log("[Playwright Bridge] Server WebSocket error", event && event.message ? event.message : "");
  };
}

connectServer();
