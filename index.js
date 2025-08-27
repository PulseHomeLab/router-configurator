#!/usr/bin/env node
/**
 * HS8247W (Vodafone-branded Huawei ONT) DNS configurator using Puppeteer (ESM version).
 *
 * Usage
 *  npm i puppeteer yargs
 *  # Ensure package.json has: { "type": "module" }
 *  node index.js --url http://192.168.1.1 --user "<u>" --pass "<p>" --dns1 1.1.1.1 --dns2 1.0.0.1
 */

import puppeteer from "puppeteer";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import path from "path";

const argv = yargs(hideBin(process.argv))
  .option("url", {
    type: "string",
    default: process.env.ROUTER_URL || "http://192.168.1.1",
    describe: "Router base URL",
  })
  .option("user", {
    type: "string",
    default: process.env.ROUTER_USER,
    demandOption: !process.env.ROUTER_USER,
    describe: "Router username",
  })
  .option("pass", {
    type: "string",
    default: process.env.ROUTER_PASS,
    demandOption: !process.env.ROUTER_PASS,
    describe: "Router password",
  })
  .option("dns1", {
    type: "string",
    default: process.env.DNS1,
    demandOption: !process.env.DNS1,
    describe: "Primary DNS server",
  })
  .option("dns2", {
    type: "string",
    default: process.env.DNS2 || "",
    describe: "Secondary DNS server (optional)",
  })
  .option("headful", {
    type: "boolean",
    default: false,
    describe: "Run headed (visible browser)",
  })
  .option("debug", {
    type: "boolean",
    default: false,
    describe: "Verbose console logging",
  })
  .help()
  .argv;

// ---- Tunable selectors (extend these if your UI differs) ---- //
const SELECTORS = {
  username: [
    'input[name="Username"]',
    'input[name="username"]',
    "input#userName",
    "input#Username",
    "input#txt_Username",
    'input[name="usr"]',
    'input[type="text"][name="user"]',
  ],
  password: [
    'input[name="Password"]',
    'input[name="password"]',
    "input#Password",
    "input#txt_Password",
    'input[type="password"]',
  ],
  loginButtons: [
    "button#loginBtn",
    "button#btn_Login",
    'button[type="submit"]',
    'input[type="submit"]',
    "input#login",
    'button[name="login"]',
    'button[onclick*="login"]',
  ],
  expertMode: ["a#expertMode", 'a[onclick*="expert"]'],
  internetTab: ["a#menu_internet", 'a[href*="internet"]'],
  basicTab: ['a[href*="basic"]'],
  lanMenu: ['a[href*="lan"]'],
  dnsMenu: [],
  dhcpTab: [],
  primaryDns: [
    "input#dnsMainPri",
    'input[name="dnsMainPri"]',
    'input[id*="dnsMainPri" i]',
    'input[id*="dnspri" i]',
    'input[name*="dnspri" i]',
    "input#PrimaryDNSServer",
    'input[name="PrimaryDNSServer"]',
    "input#primary_dns",
    'input[name="primary_dns"]',
    'input[name="dns1"]',
    "input#dns1",
    'input[id*="primary" i]',
    'input[name*="primary" i]',
  ],
  secondaryDns: [
    "input#dnsMainSec",
    'input[name="dnsMainSec"]',
    'input[id*="dnsMainSec" i]',
    'input[id*="dnssec" i]',
    'input[name*="dnssec" i]',
    "input#SecondaryDNSServer",
    'input[name="SecondaryDNSServer"]',
    "input#secondary_dns",
    'input[name="secondary_dns"]',
    'input[name="dns2"]',
    "input#dns2",
    'input[id*="secondary" i]',
    'input[name*="secondary" i]',
  ],
  manualDnsToggles: [
    'input[type="radio"][value="manual"]',
    'input[type="checkbox"][name*="manual"]',
    'select[name*="dnsMode"]',
    'select[name*="dns_mode"]',
    "select#dns_mode",
  ],
  saveButtons: [
    "button#btnApply_ex",
    'button[name="btnApply_ex"]',
    "button#btnApply",
    "button#btn_save",
    'input[type="submit"]',
    'button[type="submit"]',
  ],
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms)); // micro-optimized: keep as arrow for V8

// Get the main content frame where DHCP UI is rendered
async function getContentFrame(page) {
  // Try common ids/srcs used by this router
  const selectors = [
    "iframe#menuIframe",
    'iframe[src*="dhcp"]',
    'iframe[src*="bbsp"]',
    'iframe[src*="lan"]',
    "iframe",
  ];
  for (const sel of selectors) {
    let handle;
    try {
      handle = await page.$(sel);
    } catch {}
    if (handle) {
      let frame;
      try {
        frame = await handle.contentFrame();
      } catch {}
      if (frame) return frame;
    }
  }
  return null;
}

async function waitAndTypeFirst(page, selectors, value) {
  for (const sel of selectors) {
    let el;
    try {
      el = await page.$(sel);
    } catch {}
    if (el) {
      try {
        await el.click({ clickCount: 3 });
      } catch {}
      await el.type(value, { delay: 10 }); // slightly faster typing
      return true;
    }
  }
  return false;
}

async function setDnsByHeuristic(ctx, dns1, dns2) {
  return await ctx.evaluate(({ dns1, dns2 }) => {
    const looksLikeDns = (el) => {
      const t =
        ((el.id || "") + " " + (el.name || "") + " " + (el.className || ""))
          .toLowerCase();
      return t.includes("dns");
    };
    const inputs = Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="tel"], input:not([type])',
      ),
    )
      .filter(looksLikeDns);

    if (!inputs.length) return { ok1: false, ok2: !dns2 };

    const pick = (rx) =>
      inputs.find((el) =>
        rx.test(
          (el.id || "") + " " + (el.name || "") + " " + (el.className || ""),
        )
      );
    let pri = pick(/pri|primary|dns1|pref/i) || inputs[0];
    let sec = dns2
      ? (pick(/sec|secondary|dns2|alt/i) || inputs.find((el) => el !== pri) ||
        null)
      : null;

    const setVal = (el, v) => {
      if (!el) return false;
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };

    const ok1 = setVal(pri, dns1);
    const ok2 = dns2 ? setVal(sec, dns2) : true;
    return { ok1, ok2 };
  }, { dns1, dns2 }).catch(() => ({ ok1: false, ok2: !dns2 }));
}

async function clickFirst(page, selectors, { wait = true } = {}) {
  for (const sel of selectors) {
    let el;
    try {
      el = await page.$(sel);
    } catch {}
    if (el) {
      try {
        await el.click();
      } catch {}
      if (wait) await sleep(300); // slightly reduced sleep for perf
      return true;
    }
  }
  return false;
}

async function clickByText(page, text) {
  const clicked = await page.evaluate((t) => {
    const needle = t.toLowerCase();
    const candidates = document.querySelectorAll('button, input[type="submit"], a, [role="button"]');
    for (let i = 0; i < candidates.length; ++i) {
      const el = candidates[i];
      const inner = (el.innerText || el.textContent || "").trim().toLowerCase();
      const val = (el.value || "").trim().toLowerCase();
      if (inner.includes(needle) || val.includes(needle)) {
        el.click();
        return true;
      }
    }
    // last resort: any clickable element
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; ++i) {
      const el = all[i];
      const inner = (el.innerText || el.textContent || "").trim().toLowerCase();
      const val = (el.value || "").trim().toLowerCase();
      if (inner.includes(needle) || val.includes(needle)) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);
  if (clicked) {
    await sleep(300); // reduced sleep for perf
    return true;
  }
  return false;
}

async function clickByTextInContext(ctx, text) {
  const needle = text.toLowerCase();
  const clicked = await ctx.evaluate((n) => {
    const q = 'button, input[type="submit"], a, [role="button"], li, span, div';
    const els = document.querySelectorAll(q);
    for (let i = 0; i < els.length; ++i) {
      const el = els[i];
      if (!(el.offsetParent || (getComputedStyle(el).position === "fixed" && getComputedStyle(el).visibility !== "hidden"))) continue;
      const inner = (el.innerText || el.textContent || "").trim().toLowerCase();
      const val = (el.value || "").trim().toLowerCase();
      if (inner.includes(n) || val.includes(n)) {
        el.click();
        return true;
      }
    }
    return false;
  }, needle).catch(() => false);
  if (clicked) {
    await sleep(300); // reduced sleep for perf
    return true;
  }
  return false;
}

async function setInputByLabel(page, labelText, value) {
  return page.evaluate(({ labelText, value }) => {
    const labels = document.querySelectorAll("label");
    for (let i = 0; i < labels.length; ++i) {
      const l = labels[i];
      if (l.textContent && l.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
        const forId = l.getAttribute("for");
        let input = null;
        if (forId) input = document.getElementById(forId);
        if (!input) input = l.querySelector("input");
        if (!input && l.parentElement) input = l.parentElement.querySelector("input");
        if (input) {
          input.focus();
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, { labelText, value });
}

async function ensureManualDns(page) {
  let select;
  try {
    select = await page.$("select");
  } catch {}
  if (select) {
    const handled = await page.evaluate(() => {
      const sels = document.querySelectorAll("select");
      for (let i = 0; i < sels.length; ++i) {
        const s = sels[i];
        if (/dns/.test((s.name || "") + (s.id || "")) || /Automatic|Manual/i.test(s.innerText)) {
          for (let j = 0; j < s.options.length; ++j) {
            const o = s.options[j];
            if (/manual|static/i.test(o.textContent) || /manual/i.test(o.value)) {
              s.value = o.value;
              s.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
        }
      }
      return false;
    });
    if (handled) return true;
  }
  for (const sel of SELECTORS.manualDnsToggles) {
    let el;
    try {
      el = await page.$(sel);
    } catch {}
    if (el) {
      try {
        await el.click();
      } catch {}
      return true;
    }
  }
  if (await clickByText(page, "Manual")) return true;
  if (await clickByText(page, "Estático")) return true;
  return false;
}

async function navigateToDns(page, debug) {
  if (debug) {
    console.log(
      "Navigating via: Advanced Configuration → LAN → DHCP Server (iframe-aware)",
    );
  }

  // Click top-level: Advanced Configuration
  const advEl = await page.$("#addconfig").catch(() => null);
  if (advEl) await advEl.click().catch(() => {});
  else {
    const ok = await clickByText(page, "Advanced Configuration");
    if (!ok) return null;
  }
  await sleep(400);

  // Click second-level: LAN
  const lanEl = await page.$("#lanconfig").catch(() => null);
  if (lanEl) await lanEl.click().catch(() => {});
  else {
    const ok = await clickByText(page, "LAN");
    if (!ok) return null;
  }
  await page.waitForSelector("#lanconfig_menu", { timeout: 3000 }).catch(
    () => {},
  );
  await sleep(200);

  // Click third-level: DHCP Server
  const dhcpEl = await page.$("#landhcp").catch(() => null);
  if (dhcpEl) await dhcpEl.click().catch(() => {});
  else {
    const ok = await clickByText(page, "DHCP Server");
    if (!ok) return null;
  }

  // The DHCP page loads inside the content iframe; wait for its title to appear
  const frame = await getContentFrame(page);
  if (!frame) return null;
  try {
    await frame.waitForSelector("#dhcp2title", { timeout: 8000 });
  } catch {}
  const okTitle = await frame.evaluate(() => {
    const el = document.querySelector("#dhcp2title");
    return el &&
      /dhcp\s*server\s*configuration/i.test(
        el.innerText || el.textContent || "",
      );
  }).catch(() => false);
  if (debug) console.log("DHCP Server title detected:", !!okTitle);

  return okTitle ? "iframe-dhcp" : "iframe-dhcp-no-title";
}

async function setDnsValues(page, dns1, dns2, debug) {
  const frame = await getContentFrame(page);
  if (!frame) throw new Error("Content frame not found (menuIframe).");

  // Attempt to switch to manual if such control exists; harmless if not present
  await ensureManualDns(frame).catch(() => {});
  await sleep(300);

  // Strong selectors first inside the frame
  let ok1 = await waitAndTypeFirst(frame, SELECTORS.primaryDns, dns1);
  let ok2 = dns2
    ? await waitAndTypeFirst(frame, SELECTORS.secondaryDns, dns2)
    : true;

  // Label-based fallback inside the frame
  if (!ok1) {
    ok1 = await setInputByLabel(frame, "Primary DNS Server", dns1) ||
      await setInputByLabel(frame, "Primary DNS", dns1) ||
      await setInputByLabel(frame, "Servidor DNS primário", dns1) ||
      await setInputByLabel(frame, "Preferred DNS", dns1);
  }

  if (!ok2 && dns2) {
    ok2 = await setInputByLabel(frame, "Secondary DNS Server", dns2) ||
      await setInputByLabel(frame, "Secondary DNS", dns2) ||
      await setInputByLabel(frame, "Servidor DNS secundário", dns2) ||
      await setInputByLabel(frame, "Alternate DNS", dns2);
  }

  if ((!ok1) || (dns2 && !ok2)) {
    const { ok1: h1, ok2: h2 } = await setDnsByHeuristic(frame, dns1, dns2);
    ok1 = ok1 || h1;
    ok2 = ok2 || h2;
  }

  if (debug && (!ok1 || (dns2 && !ok2))) {
    const dbg = await frame.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map((i) => ({
        id: i.id,
        name: i.name,
        class: i.className,
        value: i.value,
      }))
    );
    console.log("DNS input candidates (debug):", dbg);
  }

  if (debug) {
    console.log("Primary field set:", ok1, "Secondary field set:", ok2);
  }
  if (!ok1) {
    throw new Error("Could not locate the Primary DNS field in the DHCP page.");
  }
}

async function saveChanges(ctx) {
  // Force-confirm within this context (Page or Frame) before clicking Apply
  try {
    await ctx.evaluate(() => {
      window.alert = function(){};
      window.confirm = function(){ return true; };
      window.prompt = function(_m, d){ return d || ''; };
    });
  } catch {}
  let applyBtn;
  try {
    applyBtn = await ctx.$("#btnApply_ex");
  } catch {}
  if (applyBtn) {
    try {
      await applyBtn.click();
    } catch {}
    await sleep(300);
    return true;
  }
  if (await clickFirst(ctx, SELECTORS.saveButtons)) { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'Apply'))   { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'Save'))    { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'Guardar')) { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'Aplicar')) { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'Submit'))  { await sleep(300); return true; }
  if (await clickByTextInContext(ctx, 'OK'))      { await sleep(300); return true; }
  // Last resort: call the page function directly if it exists
  let invoked = false;
  try {
    invoked = await ctx.evaluate(() => {
      if (typeof ApplyConfig === "function") {
        ApplyConfig();
        return true;
      }
      return false;
    });
  } catch {}
  if (invoked) {
    await sleep(300);
    return true;
  }
  return false;
}

// --- DNS value helpers ---
async function readDnsValuesFromFrame(frame) {
  // Prefer explicit ids if present
  const vals = await frame.evaluate(() => {
    const pick = (selArr) => {
      for (const s of selArr) {
        const el = document.querySelector(s);
        if (el) return el.value || "";
      }
      return "";
    };
    // Build selectors here as an inline list to avoid external capture
    const primarySels = [
      "#dnsMainPri",
      'input[name="dnsMainPri"]',
      'input[id*="dnsMainPri" i]',
      'input[id*="dnspri" i]',
      'input[name*="dnspri" i]',
      "#PrimaryDNSServer",
      'input[name="PrimaryDNSServer"]',
      "#primary_dns",
      'input[name="primary_dns"]',
      'input[name="dns1"]',
      "#dns1",
    ];
    const secondarySels = [
      "#dnsMainSec",
      'input[name="dnsMainSec"]',
      'input[id*="dnsMainSec" i]',
      'input[id*="dnssec" i]',
      'input[name*="dnssec" i]',
      "#SecondaryDNSServer",
      'input[name="SecondaryDNSServer"]',
      "#secondary_dns",
      'input[name="secondary_dns"]',
      'input[name="dns2"]',
      "#dns2",
    ];
    const primary = pick(primarySels);
    const secondary = pick(secondarySels);
    return { primary, secondary };
  }).catch(() => ({ primary: "", secondary: "" }));
  return vals;
}

async function verifyDnsApplied(
  page,
  expected1,
  expected2,
  { retries = 3, delayMs = 800 } = {},
) {
  for (let i = 0; i < retries; i++) {
    const frame = await getContentFrame(page);
    if (!frame) break;
    const { primary, secondary } = await readDnsValuesFromFrame(frame);
    const ok1 = primary === expected1;
    const ok2 = !expected2 || secondary === expected2;
    if (ok1 && ok2) return true;
    await sleep(delayMs);
    // Some firmwares re-render the form; navigate again on later retries
    if (i === retries - 2) {
      try {
        await navigateToDns(page, false);
      } catch {}
    }
  }
  return false;
}

(async () => {
  const { url, user, pass, dns1, dns2, headful, debug } = argv;
  const browser = await puppeteer.launch({
    headless: headful ? false : "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  // Auto-accept native alerts/confirms/prompts (e.g., triple-play warning)
  page.on('dialog', async d => {
    try {
      if (argv.debug) console.log('Dialog:', d.type(), d.message());
      await d.accept();
    } catch {}
  });

  // Ensure window.confirm/alert/prompt auto-accept in every document/iframe
  await page.evaluateOnNewDocument(() => {
    window.__AUTO_CONFIRM__ = true;
    window.alert = function(){};
    window.confirm = function(){ return true; };
    window.prompt = function(_m, d){ return d || ''; };
  });

  page.setDefaultTimeout(15000);

  try {
    if (debug) console.log("Opening", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const usernameTyped = await waitAndTypeFirst(page, SELECTORS.username, user);
    const passwordTyped = await waitAndTypeFirst(page, SELECTORS.password, pass);

    if (!usernameTyped && debug) {
      console.log("Username field not found; continuing (some firmwares use password-only login).",
      );
    }
    if (!passwordTyped) {
      throw new Error("Password field not found on login page.");
    }

    const clickedLogin =
      await clickFirst(page, SELECTORS.loginButtons, { wait: true }) ||
      await clickByText(page, "Log In") ||
      await clickByText(page, "Login") ||
      await clickByText(page, "Entrar") ||
      await clickByText(page, "Iniciar sessão") ||
      await clickByText(page, "Iniciar sesión");
    if (!clickedLogin && debug) {
      console.log("No explicit login button clicked (page may auto-submit).");
    }

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 15000,
    }).catch(() => {});
    await sleep(600); // slightly reduced sleep for perf

    const pathReached = await navigateToDns(page, debug);
    if (!pathReached) {
      throw new Error("Could not reach DNS page automatically. Run with --headful and adjust SELECTORS.");
    }
    if (debug) {
      const cf = await getContentFrame(page);
      console.log("Content frame URL:", cf ? cf.url() : "N/A");
    }
    if (debug) console.log("Reached DNS page via path:", pathReached);

    await setDnsValues(page, dns1, dns2, debug);
    const contentFrame = await getContentFrame(page);
    const saved = await saveChanges(contentFrame || page);

    // Give the router a moment to apply settings and re-render the form
    await sleep(900); // reduced sleep for perf
    const verified = await verifyDnsApplied(page, dns1, dns2, {
      retries: 4,
      delayMs: 800,
    });
    if (debug) {
      console.log("Post-apply DNS verification:", verified ? "matched" : "not matched yet");
    }

    if (debug) {
      const cf = await getContentFrame(page);
      const found = cf
        ? await cf.evaluate(() => {
          const labels = document.querySelectorAll("label");
          let primary = false, secondary = false;
          for (let i = 0; i < labels.length; ++i) {
            const t = (labels[i].innerText || labels[i].textContent || "").trim().toLowerCase();
            if (t.includes("primary dns server") || t.includes("primary dns")) primary = true;
            if (t.includes("secondary dns server") || t.includes("secondary dns")) secondary = true;
          }
          return { primary, secondary };
        }).catch(() => ({ primary: false, secondary: false }))
        : { primary: false, secondary: false };
      console.log("Field presence (labels):", found);
    }

    if (!saved) throw new Error("Could not find a Save/Apply button.");

    await sleep(600);

    console.log(`✔ DNS updated to ${dns1}${dns2 ? `, ${dns2}` : ""}`);
  } catch (err) {
    console.error("✖ Failed:", err.message);
    if (argv.debug) {
      try {
        const shot = path.resolve(process.cwd(), `debug-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.error("Saved screenshot:", shot);
      } catch {}
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
