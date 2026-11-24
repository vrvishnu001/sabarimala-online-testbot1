// bot.js - config-driven booking bot (driven by the UI via server.js).
// server.js creates one INDEPENDENT instance per bot with createBot(id), so Bot 1..4
// never share a browser, config, stop flag or log.

const { chromium } = require('playwright');

function createBot(botId) {
    let LOG = (line) => process.stdout.write(`[Bot ${botId}] ${line}\n`);
    const console = {
        log: (...a) => LOG(a.join(' ')),
        error: (...a) => LOG(a.map(x => (x && x.message) || x).join(' ')),
    };
    let STOPPED = false;
    let activeBrowser = null;

    // ---- Live booking progress (shown at the top of the console in the UI) ----
    // One entry per pilgrim row: status = 'pending' | 'booking' | 'booked'.
    let progressFn = () => {};
    let progress = { items: [], step: '', round: 0, session: 0 };
    let lastDate = '';   // date picked in the current round, e.g. "Nov 24 2026"
    let lastSlot = '';   // slot picked in the current round, e.g. "05:00 - 06:00"
    const emitProgress = () => { try { progressFn(JSON.parse(JSON.stringify(progress))); } catch (e) { /* never break the bot */ } };
    const setStep = (text) => { progress.step = text; emitProgress(); };
    // One-line status printed INTO the console log, so it is visible even if the page has no status panel.
    const logSummary = () => {
        const items = progress.items;
        if (!items.length) return;
        const lm = progress.lastMessage;
        const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
        const booked = items.filter((i) => i.status === 'booked');
        const going = items.filter((i) => i.status === 'booking');
        const waiting = items.filter((i) => i.status === 'pending');
        console.log(`📊 STATUS: Booked ${booked.length}/${items.length}` +
            (booked.length ? ` [${booked.map((i) => `row ${i.row} at ${clock(i.bookedAt)}, ${i.date || '-'}, slot ${i.slot || '-'}${i.txnId ? ', txn ' + i.txnId : ''}`).join(' | ')}]` : '') +
            ` | In progress: ${going.length ? going.map((i) => 'row ' + i.row).join(', ') : 'none'}` +
            ` | Remaining: ${waiting.length + going.length ? [...going, ...waiting].map((i) => 'row ' + i.row).join(', ') : 'none'}` +
            (items.some((i) => i.skipped && i.status !== 'booked') ? ` | Skipped (retry later): ${items.filter((i) => i.skipped && i.status !== 'booked').map((i) => 'row ' + i.row + (i.note ? ` - site said: "${i.note.split('"')[1] || ''}"` : '')).join(', ')}` : '') +
            (lm ? ` | Last site message: "${lm.text}" -> ${lm.action}` : ''));
    };
    // Remembers the last message the SITE showed (and what the bot did about it), per pilgrim and overall,
    // so it is visible in the status panel at the top of the console.
    const noteSiteMessage = (kind, text, rows, action) => {
        const at = new Date().toISOString();
        progress.lastMessage = { kind, text, action, at, rows };
        for (const it of progress.items) {
            if (rows.includes(it.row)) it.note = `${action}: "${text}"`;
        }
        emitProgress();
        logSummary();
    };
    const setStatus = (rows, status, extra) => {
        for (const it of progress.items) {
            if (rows.includes(it.row)) {
                Object.assign(it, { status }, extra || {});
                if (status !== 'pending') it.note = ''; // moving on: the old message no longer applies
            }
        }
        emitProgress();
        logSummary();
    };
    let slotApiDiagnostics = [];

    // Set these as environment variables, or replace the placeholders below.
    //   Windows (cmd):        set SABARI_USER=xxxx && set SABARI_PASS=xxxx && node uthai.js
    //   Windows (PowerShell): $env:SABARI_USER="xxxx"; $env:SABARI_PASS="xxxx"; node uthai.js
    let USERNAME = process.env.SABARI_USER || '';
    let PASSWORD = process.env.SABARI_PASS || '';

    // -------------------------------------------------------------------------
    // --- 1. CONFIGURATION CONSTANTS ---
    // -------------------------------------------------------------------------

    // Dates to check (use 3-letter month format: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
    // Put your most preferred date FIRST. The first one found available is selected.
    let TARGET_DATES = [
        { label: 'Nov 24', day: '24', month: 'Nov', year: '2026' },
        { label: 'Dec 17', day: '17', month: 'Dec', year: '2026' },
        // { label: 'Jan 14', day: '14', month: 'Jan', year: '2027' },
    ];

    // Pilgrim rows to tick on the pilgrim selection page (row numbers, starting from 1).
    // Example: [1, 3] selects the 1st and 3rd pilgrim rows.
    let PILGRIM_ROWS = [2,3,4,5];

    // Nominee details. The site has one nominee row per selected pilgrim, and this
    // SAME nominee is filled in EVERY row (2, 3, 4, 5 pilgrims... any count).
    //   name:     letters and spaces only, max 32 characters
    //   age:      digits only, max 3 digits
    //   relation: Father, Mother, Son, Daughter, Brother, Sister, Spouse
    let DEFAULT_NOMINEE = { name: 'Example Nominee', age: '30', relation: 'Father' };

    // Optional: use a different nominee for a specific pilgrim row (row number starts at 1).
    // Rows not listed here use DEFAULT_NOMINEE.
    let NOMINEE_OVERRIDES = {
        // 2: { name: 'Kumar', age: '28', relation: 'Brother' },
    };

    // Relation name -> dropdown option value on the site
    const RELATION_VALUES = {
        father: '1',
        mother: '2',
        son: '3',
        daughter: '4',
        brother: '5',
        sister: '6',
        spouse: '11',
    };

    // The specific Route option value for "Pamba - Marakkoottam - 4 Kms"
    let ROUTE_VALUE = '1';
    const ROUTE_SELECTOR = 'select[name="reportingPlace"]';

    // Selector for any available time slot div (used to check if slots loaded)
    const AVAILABLE_SLOT_SELECTOR = 'div.slot-dar-5:has-text("Availability:")';

    // Selector for the clickable parent element of the time slot
    const TIME_SLOT_CLICK_PARENT = '.slot-media:has(.slot-dar-5:has-text("Availability:"))';

    // Slot selection mode:
    //   1 = AUTO       -> script picks the slot itself (first slot that fits all pilgrims,
    //                     otherwise the slot with the most seats).
    //   0 = PARTICULAR -> script picks only from SLOT_PREFERENCES below.
    let AUTO_SLOT_SELECTION = 1;

    // Used only when AUTO_SLOT_SELECTION = 0. Write the time exactly as the site shows it.
    // Put your most preferred slot FIRST; the first one that has seats is selected.
    // If none of them has seats, the round restarts (it will NOT fall back to another slot).
    let SLOT_PREFERENCES = [
        '05:00 - 06:00',
        // '10:00 - 11:00',
        // '11:00 - 12:00',
    ];

    const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    // --- Timeout settings ---
    // Every click / fill / wait / navigation gives up after this many ms (Playwright's default is 30000).
    const ACTION_TIMEOUT_MS = 10000;
    // Only two waits stay longer, because the site can be slow there: the slot cards
    // loading after the route is picked, and the payment page loading after "Proceed".
    const SLOW_WAIT_MS = 30000;

    // --- Never-stop retry settings ---
    // If a round fails (no slot, page error, booking not confirmed...), the whole flow restarts
    // from the first step (the wishlist is cleared again) and the same pilgrims are retried.
    //   * MAX_RETRIES retries (default 5), RETRY_DELAY_MS apart, reuse the same browser.
    //   * If the retries are used up, the browser is closed, the bot waits COOLDOWN_MS
    //     (default 1 minute) and then starts again from a FRESH browser and a fresh LOGIN.
    //   * The bot NEVER gives up. It ends only when every pilgrim is booked, or you press Stop.
    let MAX_RETRIES = 5;
    let RETRY_DELAY_MS = 5000;
    let COOLDOWN_MS = 60000;

    // Wishlist check: how long to wait for the "Clear Wishlist" button before the wishlist is
    // judged empty. If WISHLIST_DOUBLE_CHECK is true, the page is reloaded ONCE and checked again
    // before trusting "empty" (costs a few seconds per round; set to false to skip it).
    const WISHLIST_WAIT_MS = 3000;
    const WISHLIST_DOUBLE_CHECK = false; // fresh browser every attempt, so no extra reload is needed

    // How many times to click "Add to Wishlist" if the Proceed popup does not appear.
    const ADD_TO_WISHLIST_ATTEMPTS = 3;

    // --- Booking success check ---
    // A round counts as BOOKED ONLY when the "Booking Confirmation" popup appears after the final
    // "Proceed" and it says the transaction is successful, e.g.:
    //   <div class="feedback_form"> Booking Confirmation ... Your transaction is successful with
    //   Transaction ID:1928712499 ... Please rate Us ... <button id="regi_continue"> OK </button>
    // If a popup appears but does NOT say that, or nothing appears, the round FAILED and the whole
    // flow restarts from a fresh browser and a fresh login.
    const FEEDBACK_WAIT_MS = 60000; // how long to wait for the popup after the final "Proceed"
    const CONFIRM_POPUP_SELECTOR = '.feedback_form';
    const CONFIRM_OK_SELECTOR = '.feedback_form button#regi_continue, .feedback_form button.btn-addto-pop';
    const CONFIRM_SUCCESS_REGEX = /transaction is successful|transaction id\s*:?\s*\d+/i;
    let lastTransactionId = ''; // Transaction ID read from the popup of the latest confirmed booking

    // Remembers who each pilgrim row is (by its text), so after some pilgrims are booked
    // and the list changes, the remaining ones are still found correctly.
    const pilgrimIdentity = {};

    // -------------------------------------------------------------------------
    // --- 2. MAIN EXECUTION FUNCTION ---
    // -------------------------------------------------------------------------

    const hostOf = (url) => { try { return new URL(url).hostname || 'unknown host'; } catch (e) { return 'unknown host'; } };

    /** Waits ms milliseconds but returns early if Stop is pressed. */
    async function sleep(ms) {
        const end = Date.now() + ms;
        while (!STOPPED && Date.now() < end) {
            await new Promise((r) => setTimeout(r, Math.max(0, Math.min(500, end - Date.now()))));
        }
    }

    /** Opens a brand-new browser (no cookies, so the next step is a fresh login). */
    async function openSession() {
        // Browser choice:
        //  * "Use my installed Google Chrome" ticked -> your real Chrome (same as the original test.js).
        //  * otherwise Playwright's own Chromium.
        const launchOpts = { headless: HEADLESS };
        if (USE_INSTALLED_CHROME) launchOpts.channel = 'chrome';
        const browser = await chromium.launch(launchOpts);
        activeBrowser = browser;
        if (STOPPED) {
            await browser.close().catch(() => {});
            throw new Error('Stopped');
        }

        let page;
        try {
            // Same browser identity as the old, working bot: a fixed Windows Chrome user agent.
            // (This also avoids the "HeadlessChrome" name that makes the site load a blank page.)
            const pageOpts = {
                viewport: { width: 1366, height: 850 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            };
            page = await browser.newPage(pageOpts);
        } catch (e) {
            await browser.close().catch(() => {}); // never leave a browser running if setup fails
            throw e;
        }

        // All actions and navigations time out after ACTION_TIMEOUT_MS instead of 30 s.
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);

        const apiNote = (method, url, status) => {
            let where = hostOf(url);
            try {
                const u = new URL(url);
                // Keep the path for failures and for wishlist calls, so the log shows exactly what failed.
                if (status === 'failed' || status >= 400 || /wish/i.test(u.pathname)) where = u.hostname + u.pathname;
            } catch (e) { /* keep host only */ }
            slotApiDiagnostics.push(`${method} ${where} ${status}`);
            if (slotApiDiagnostics.length > 30) slotApiDiagnostics.shift();
        };
        page.on('response', (response) => {
            const request = response.request();
            if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
            apiNote(request.method(), response.url(), response.status());
        });
        page.on('requestfailed', (request) => {
            if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
            apiNote(request.method(), request.url(), 'failed');
        });
        page.on('pageerror', (error) => console.error(`Browser page error: ${error.message}`));

        return { browser, page };
    }

    async function runBookingBot() {
        let remaining = [...PILGRIM_ROWS]; // pilgrim rows still NOT confirmed booked
        for (const k of Object.keys(pilgrimIdentity)) delete pilgrimIdentity[k];
        progress = { items: PILGRIM_ROWS.map((row) => ({ row, status: 'pending' })), step: 'Starting', round: 0, session: 0 };
        emitProgress();
        let failures = 0;   // failed attempts in a row (reset after a success or after the cool-down)
        // Pilgrims the site refused with "You cannot make transaction until you avail previous booking".
        // They are skipped while other pilgrims are still waiting, and tried again when those are done.
        let skipped = [];
        let forceCooldown = false; // true when only skipped pilgrims are left (wait before trying them again)
        const syncSkipped = () => {
            for (const it of progress.items) it.skipped = skipped.includes(it.row);
            emitProgress();
        };
        let round = 0;
        let session = 0;

        // Outer loop = one browser session per pass. It only ends when everyone is booked or Stop is pressed.
        while (remaining.length > 0 && !STOPPED) {
            session++;
            progress.session = session;
            setStep(`Session ${session}: opening a fresh browser and logging in`);
            let browser = null;
            try {
                console.log(`\n######## SESSION ${session}: opening a fresh browser, login starts from scratch ########`);
                const opened = await openSession();
                browser = opened.browser;
                const page = opened.page;
                let nextFromDate = false; // true -> next round skips login and starts at date selection

                while (remaining.length > 0 && !STOPPED) {
                    round++;
                    progress.round = round;
                    lastDate = ''; lastSlot = '';

                    // Pilgrims to book now = everyone not booked and not skipped. When only skipped
                    // pilgrims are left, they are tried again.
                    let pending = remaining.filter((r) => !skipped.includes(r));
                    if (pending.length === 0 && skipped.length > 0) {
                        console.log(`\n🔄 All other pilgrims are done. Trying the skipped pilgrim(s) again: rows ${skipped.join(', ')}`);
                        skipped = [];
                        syncSkipped();
                        pending = [...remaining];
                    }

                    console.log(`\n==================== ROUND ${round} ====================`);
                    console.log(`Pilgrims to book now (rows): ${pending.join(', ')}${skipped.length ? `   |   Skipped for later: ${skipped.join(', ')}` : ''}`);
                    logSummary();

                    try {
                        // Returns rows only after the booking was CONFIRMED (see verifyBookingSuccess).
                        const fromDate = nextFromDate;
                        nextFromDate = false;
                        const bookedRows = await runOneRound(page, pending, fromDate);

                        if (!bookedRows || bookedRows.length === 0) {
                            throw new Error('No pilgrim could be booked in this round.');
                        }

                        // Confirmed booked -> remove them from the remaining list.
                        remaining = remaining.filter((r) => !bookedRows.includes(r));
                        skipped = skipped.filter((r) => remaining.includes(r));
                        failures = 0;
                        forceCooldown = false;
                        setStatus(bookedRows, 'booked', { bookedAt: new Date().toISOString(), date: lastDate, slot: lastSlot, txnId: lastTransactionId });
                        setStep(remaining.length ? `Booked ${bookedRows.length}. Waiting to book the remaining ${remaining.length}` : 'All pilgrims booked');
                        console.log(`✅ Booked row(s): ${bookedRows.join(', ')}. Remaining: ${remaining.length ? remaining.join(', ') : 'none'}`);
                        if (remaining.length > 0) {
                            console.log('ℹ️ Some pilgrims are still left. Next round starts from a fresh browser and a fresh login.');
                            break;
                        }
                    } catch (err) {
                        if (STOPPED) break;

                        // Site said "pending booking for the same slot / quota not available":
                        // stay in this browser and retry from date selection (no new login).
                        if (err && err.restartFromDate) {
                            setStatus(remaining, 'pending', { slot: '', date: '' });
                            noteSiteMessage('pending-slot', err.siteMessage || '', (err.rows && err.rows.length) ? err.rows : pending, 'Retry from date selection');
                            setStep(`Round ${round}: site said "${err.siteMessage || ''}". Retrying from date selection`);
                            console.log(`🔁 Retrying from DATE SELECTION in ${RETRY_DELAY_MS / 1000}s (same browser, no new login)...`);
                            nextFromDate = true;
                            await sleep(RETRY_DELAY_MS);
                            continue;
                        }

                        // Site said "You cannot make transaction until you avail previous booking":
                        // skip THESE pilgrims for now, carry on with the others, retry the skipped ones last.
                        if (err && err.skipUser) {
                            const rows = (err.rows && err.rows.length) ? err.rows : pending.slice(0, 1);
                            skipped = [...new Set([...skipped, ...rows])];
                            setStatus(remaining, 'pending', { slot: '', date: '' });
                            syncSkipped();
                            noteSiteMessage('blocked', err.siteMessage || '', rows, 'Skipped for now');
                            const others = remaining.filter((r) => !skipped.includes(r));
                            console.log(`⏭ Skipping pilgrim row(s) ${rows.join(', ')} for now (previous booking not availed). ` +
                                (others.length
                                    ? `Continuing with rows ${others.join(', ')}; the skipped ones are tried again after those are done.`
                                    : 'No other pilgrims are left, so the skipped ones will be tried again after a short wait.'));
                            logSummary();
                            if (others.length === 0) forceCooldown = true;
                            setStep(`Skipped row(s) ${rows.join(', ')} - site said: "${err.siteMessage || ''}". Restarting from login`);
                            console.log('🔁 Closing the browser and restarting from LOGIN...');
                            break;
                        }

                        failures++;
                        // Pilgrims that were "in progress" in this round go back to waiting.
                        setStatus(remaining, 'pending', { slot: '', date: '' });
                        if (err && err.skipUser) setStep(`Round ${round}: previous booking not availed. Restarting from login`);
                        setStep(`Round ${round} failed. Retrying from login...`);
                        console.error(`⚠️ Round ${round} failed: ${String(err && err.message || err).split('\n')[0]}`);
                        console.log(`Still not booked: rows ${remaining.join(', ')}`);

                        // EVERY failure ends this browser session. The browser is closed in the
                        // `finally` below (cookies, login, Angular form state are all thrown away)
                        // and the next attempt opens a brand-new browser and logs in again.
                        // Reusing the old page was the bug: goto('#/darshan') on a page that is
                        // already on #/darshan does not reload it, so the old, half-filled form
                        // (Select Route invalid) was reused.
                        if (failures <= MAX_RETRIES) {
                            console.log(`🔁 Retry ${failures}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s: closing the browser, clearing the session, restarting from LOGIN...`);
                        }
                        break;
                    }
                }
            } catch (err) {
                // Browser could not be launched / crashed outside a round. Count it like a failed attempt.
                if (!STOPPED) {
                    failures++;
                    console.error(`⚠️ Browser session problem: ${String(err && err.message || err).split('\n')[0]}`);
                }
            } finally {
                activeBrowser = null;
                if (browser) await browser.close().catch(() => {});
            }

            if (STOPPED || remaining.length === 0) break;

            if (failures > MAX_RETRIES || forceCooldown) {
                console.log(forceCooldown
                    ? `\n⏳ Only skipped pilgrims are left. Waiting ${COOLDOWN_MS / 1000}s, then trying them again from LOGIN with a fresh browser...`
                    : `\n⏳ ${MAX_RETRIES} retries did not work. Waiting ${COOLDOWN_MS / 1000}s, then restarting from LOGIN with a fresh browser...`);
                await sleep(COOLDOWN_MS);
                failures = 0;
                forceCooldown = false;
            } else {
                await sleep(RETRY_DELAY_MS);
            }
        }

        if (STOPPED) {
            console.log('\n⏹ Stopped by user.');
        } else {
            console.log('\n🎉 ALL PILGRIMS ARE BOOKED. Automation finished.');
        }
    }

    /**
     * One full booking pass (login -> clear wishlist -> date -> route/slot -> pilgrims -> nominees -> checkout)
     * for as many of the remaining pilgrims as the chosen slot has room for.
     * Returns the list of pilgrim rows ONLY if the booking was confirmed; otherwise it throws.
     */
    async function runOneRound(page, remaining, fromDate) {
        if (fromDate) {
            // Same browser and same login: just reload the booking page and start at the date.
            console.log('--- RETRY FROM DATE SELECTION (same browser, no new login) ---');
            setStep(`Round ${progress.round}: reloading the page and selecting the date again`);
            await page.reload();
            await page.waitForSelector(ROUTE_SELECTOR, { state: 'visible', timeout: ACTION_TIMEOUT_MS });
        } else {
            console.log('--- STARTING LOGIN & NAVIGATION ---');
            setStep(`Round ${progress.round}: logging in and checking the wishlist`);
            const resumedRows = await loginAndOpenBookingPage(page, remaining);
            if (resumedRows) return resumedRows; // the wishlist item was booked directly (slot was available)
        }

        // Date selection (loops/refreshes until the target date is available)
        setStep(`Round ${progress.round}: waiting for the date to open`);
        const dateSelected = await selectDateOnly(page);
        if (!dateSelected) {
            throw new Error('Failed to select a date.');
        }

        // Route + slot. The slot's availability decides how many pilgrims we can book now.
        setStep(`Round ${progress.round}: selecting route and time slot`);
        const slot = await selectRouteAndSlot(page, remaining.length);
        if (!slot.ok) {
            throw new Error('Failed to select a slot after route selection.');
        }

        const countThisRound = Math.min(slot.availability, remaining.length);
        const rowsThisRound = remaining.slice(0, countThisRound);
        lastSlot = slot.time || '';
        setStatus(rowsThisRound, 'booking', { slot: lastSlot, date: lastDate });
        setStep(`Round ${progress.round}: booking ${rowsThisRound.length} pilgrim(s) in slot ${lastSlot || '?'}`);

        if (countThisRound < remaining.length) {
            console.log(`ℹ️ Only ${slot.availability} seat(s) available but ${remaining.length} pilgrim(s) remain. Booking ${countThisRound} now, the rest in the next round.`);
        } else {
            console.log(`ℹ️ Enough seats (${slot.availability}) for all ${remaining.length} remaining pilgrim(s).`);
        }

        // Select "Others (Upto 5 Pilgrims)"
        try {
            await page.locator('mat-radio-button:has-text("Others")').first().locator('label').click({ timeout: 3000 });
        } catch (e) {
            await page.click('#mat-radio-3'); // fallback to the original selector
        }
        console.log('Selected "Others" group option.');

        // Click Select Pilgrim Button
        await Promise.all([
            page.waitForURL('**/piligrimServiceMaster', { timeout: ACTION_TIMEOUT_MS }),
            page.click('button:has-text("Select Pilgrim")')
        ]);
        console.log('Clicked "Select Pilgrim" and navigated to selection page.');

        // Select only the pilgrims that fit
        const picked = await selectPilgrims(page, rowsThisRound);
        if (picked.length === 0) {
            throw new Error('No pilgrim could be ticked on the selection page.');
        }
        for (const it of progress.items) {
            if (pilgrimIdentity[it.row]) it.label = pilgrimIdentity[it.row].slice(0, 40);
        }
        emitProgress();

        // Submit on pilgrim page
        await Promise.all([
            page.waitForURL('**/darshan', { timeout: ACTION_TIMEOUT_MS }),
            page.click('button#regi_continue:has-text("Submit")')
        ]);
        console.log('Clicked Submit on Pilgrim page and returned to darshan page.');

        // Nominee details (every nominee row on the page)
        setStep(`Round ${progress.round}: filling nominee details`);
        await fillNominees(page, picked);

        // "No" for both contribution options
        await selectContributionNo(page);

        // Wishlist & checkout steps (throws if the booking is not confirmed)
        setStep(`Round ${progress.round}: checkout and payment`);
        try {
            await handleFinalSteps(page);
        } catch (e) {
            if (e && (e.skipUser || e.restartFromDate)) e.rows = picked.map((p) => p.row); // which pilgrims this message is about
            throw e;
        }

        return picked.map((p) => p.row);
    }

    // -------------------------------------------------------------------------
    // --- 3. HELPER FUNCTIONS ---
    // -------------------------------------------------------------------------

    /**
     * Initial steps: open the site, login if needed, go to the Virtual-Q booking page,
     * then clear the wishlist if it has an item. Runs at the start of EVERY round.
     */
    async function loginAndOpenBookingPage(page, remaining) {
        await page.goto('https://sabarimalaonline.org/#/darshan');

        let needLogin = false;
        try {
            await page.waitForSelector('#email', { state: 'visible', timeout: 6000 });
            needLogin = true;
        } catch (e) {
            needLogin = false;
        }

        if (needLogin) {
            await page.fill('#email', USERNAME);
            await page.fill('#password', PASSWORD);
            await Promise.all([
                page.waitForURL('**/home', { timeout: ACTION_TIMEOUT_MS }),
                page.click('#regi_continue')
            ]);
            console.log('Login attempt successful.');
        } else {
            console.log('Already logged in.');
        }

        if (!page.url().includes('/darshan')) {
            await page.waitForSelector('#container', { state: 'visible', timeout: ACTION_TIMEOUT_MS });
            await Promise.all([
                page.waitForURL('**/darshan', { timeout: ACTION_TIMEOUT_MS }),
                page.click('#container')
            ]);
        }
        console.log('Navigated to Virtual-Q booking page.');

        // Wishlist check: if an item is there and its slot is still available, finish that booking
        // (click Proceed). Otherwise clear it and carry on with the normal flow.
        const resumedRows = await clearWishlistIfPresent(page, () => resumeFromWishlistIfSlotAvailable(page, remaining));
        if (resumedRows) return resumedRows;

        await page.waitForSelector(ROUTE_SELECTOR, { state: 'visible', timeout: ACTION_TIMEOUT_MS });
        console.log('Booking page elements are stable. Starting checks.');
    }

    // --- Resume from an existing wishlist item ---
    // After login: if the wishlist already holds an item AND its slot is still available
    // (the red #slotMsg text beside "Virtual-Q" is blank), click the wishlist's "Proceed" and finish the
    // booking from there. If the slot is NOT available (a message is shown), clear the wishlist.
    const SLOT_MSG_SETTLE_MS = 1500; // the slot message is filled in a moment after the box appears
    let resumeFailedBefore = false;  // if resuming failed once, the next round clears the wishlist instead

    /**
     * Compares the wishlist date (shown as dd-mm-yyyy, e.g. "26-11-2026") with the dates set for this bot
     * (TARGET_DATES). Returns the matching target date, or null if it is different / cannot be read.
     */
    function matchWishlistDate(wishlistDate) {
        const m = String(wishlistDate || '').match(/(\d{1,2})\D+(\d{1,2})\D+(\d{4})/);
        if (!m) return null;
        const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
        return TARGET_DATES.find((t) =>
            parseInt(t.day, 10) === day &&
            MONTH_NAMES.indexOf(String(t.month).toUpperCase()) + 1 === month &&
            parseInt(t.year, 10) === year
        ) || null;
    }

    async function resumeFromWishlistIfSlotAvailable(page, remaining) {
        if (resumeFailedBefore) {
            console.log('ℹ️ The previous attempt to continue from the wishlist failed, so the wishlist will be cleared this time.');
            resumeFailedBefore = false;
            return null;
        }

        await page.waitForTimeout(SLOT_MSG_SETTLE_MS);
        const box = page.locator('#wishlist-box').first();
        const slotMsg = await box.locator('#slotMsg').first().innerText({ timeout: 1500 })
            .then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => '');
        const details = await box.evaluate((el) => {
            const out = {};
            el.querySelectorAll('.wishlist-list li').forEach((li) => {
                const label = (li.querySelector('b') || {}).innerText;
                const value = (li.querySelector('.entry') || {}).innerText;
                if (label) out[label.trim()] = (value || '').replace(/\s+/g, ' ').trim();
            });
            return out;
        }).catch(() => ({}));

        const wlDate = details['Date'] || '';
        const wlTime = details['Time'] || '';
        const wlPilgrims = parseInt(details['No. of Pilgrims'], 10);
        console.log(`Wishlist has an item: date ${wlDate || '?'}, time ${wlTime || '?'}, pilgrims ${Number.isNaN(wlPilgrims) ? '?' : wlPilgrims}. Slot message: "${slotMsg || '(none)'}"`);

        // 1) The wishlist date must be one of the dates set in the bot (the time slot is NOT compared).
        const matchedDate = matchWishlistDate(wlDate);
        if (!matchedDate) {
            console.log(`Wishlist date "${wlDate || 'unreadable'}" is not one of the bot's dates (${TARGET_DATES.map((t) => `${t.label} ${t.year}`).join(', ')}). Clearing the wishlist.`);
            return null; // caller clears it
        }
        console.log(`✅ Wishlist date ${wlDate} matches the bot's date ${matchedDate.label} ${matchedDate.year}.`);

        // 2) The slot of that wishlist item must still be available.
        if (slotMsg) {
            console.log('Slot is NOT available for the wishlist item. Clearing the wishlist.');
            return null; // caller clears it
        }

        console.log('✅ Slot is available for the wishlist item. Clicking "Proceed" in the wishlist.');
        const count = Number.isNaN(wlPilgrims) || wlPilgrims < 1 ? remaining.length : Math.min(wlPilgrims, remaining.length);
        const rows = remaining.slice(0, count);
        lastDate = `${matchedDate.label} ${matchedDate.year}`; lastSlot = wlTime;
        setStatus(rows, 'booking', { slot: lastSlot, date: lastDate });
        setStep(`Round ${progress.round}: continuing from the wishlist (slot ${wlTime || '?'})`);

        try {
            const wishlistProceed = box.locator('button:has-text("Proceed")').first();
            await wishlistProceed.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
            await checkoutFromProceed(page, wishlistProceed);
        } catch (err) {
            resumeFailedBefore = true; // next round: clear the wishlist and book normally
            err.fromResume = true;
            throw err;
        }
        return rows;
    }

    /**
     * If the wishlist box has an item (the "Clear Wishlist" button is visible),
     * clears it and confirms the popup. Does nothing when the wishlist is empty.
     */
    async function describeWishlist(page, when) {
        const html = await page.locator('#wishlist-box').first().evaluate((el) => el.outerHTML, undefined, { timeout: 1500 })
            .then((t) => t.replace(/\s+/g, ' ').slice(0, 300))
            .catch(() => 'no #wishlist-box element on the page');
        console.log(`   [wishlist diagnostics, ${when}] url=${page.url()}`);
        console.log(`   [wishlist diagnostics, ${when}] box: ${html}`);
        console.log(`   [wishlist diagnostics, ${when}] recent requests: ${slotApiDiagnostics.slice(-8).join(' | ') || 'none seen'}`);
    }

    async function clearWishlistIfPresent(page, beforeClear) {
        console.log('--- CHECKING WISHLIST ---');
        try {
            // The wishlist box is part of the booking page. If it never appears, the page itself did
            // not load (blank page / blocked), which is NOT the same as an empty wishlist.
            try {
                await page.waitForSelector('#wishlist-box', { state: 'attached', timeout: 10000 });
            } catch (e) {
                const title = await page.title().catch(() => '');
                const text = await page.locator('body').innerText({ timeout: 3000 })
                    .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 200)).catch(() => '');
                throw new Error(`The booking page did not load (no wishlist box). Page title: "${title}". Page text: "${text || 'blank'}". The site may be blocking this browser.`);
            }

            // Same selector as the original script (.first() only guards against duplicates).
            const clearBtn = page.locator('#wishlist-box button:has-text("Clear Wishlist")').first();
            const appears = async (ms) => {
                try { await clearBtn.waitFor({ state: 'visible', timeout: ms }); return true; } catch (e) { return false; }
            };

            let found = await appears(WISHLIST_WAIT_MS);

            if (!found && WISHLIST_DOUBLE_CHECK) {
                await describeWishlist(page, 'first look');
                console.log('Wishlist looks empty. Reloading the page once to double-check...');
                await page.reload();
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                found = await appears(WISHLIST_WAIT_MS);
            }

            if (!found) {
                await describeWishlist(page, 'final');
                // If the site refused / failed the wishlist request, "empty" is NOT trustworthy.
                const refused = slotApiDiagnostics.slice(-15).filter((l) => /wish/i.test(l) && (/ failed$/.test(l) || / [45]\d\d$/.test(l)));
                if (refused.length > 0) {
                    throw new Error(`The site refused the wishlist request (${refused[refused.length - 1]}), so the wishlist could not be checked.`);
                }
                console.log('Wishlist is empty. Continuing.');
                return;
            }

            // An item IS in the wishlist. The hook may decide to book it instead of clearing it.
            if (beforeClear) {
                const handled = await beforeClear();
                if (handled) return handled;
            }

            await clearBtn.click({ timeout: ACTION_TIMEOUT_MS });
            console.log('Clicked "Clear Wishlist".');

            // Confirmation popup: "Are you sure you want to clear the Wishlist?" -> Yes
            const yesBtn = page.locator('button.btn-addto-pop:has-text("Yes")');
            await yesBtn.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
            await yesBtn.click({ timeout: ACTION_TIMEOUT_MS });

            // Wait until the Clear Wishlist button disappears (wishlist actually cleared)
            await clearBtn.waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS });
            console.log('✅ Wishlist cleared.');
        } catch (err) {
            if (!err.fromResume) console.log(`⚠️ Wishlist clear failed: ${err.message.split('\n')[0]}`);
            throw err; // restarts the round so we never continue with a stale wishlist
        }
    }

    /**
     * Builds an exact-match regex for a calendar cell's aria-label.
     * Matches: "Dec 20 2026", "Dec 20, 2026", "December 20, 2026", "December 20 2026", "Dec 020 2026" (leading zero)
     * Does NOT match "Dec 2 2026", "Dec 21 2026", etc.
     */
    function buildLabelRegex(targetDate) {
        const dayNum = String(parseInt(targetDate.day, 10));
        return new RegExp(
            `^${targetDate.month}[a-z]*\\.?\\s+0?${dayNum},?\\s+${targetDate.year}$`,
            'i'
        );
    }

    /** How long to wait for the date picker button after a page load (the site can be slow when busy). */
    const DATE_PAGE_WAIT_MS = 20000;
    /** After this many date-check errors in a row (any step), close the browser and restart from the LOGIN page. */
    const DATE_PAGE_MAX_FAILS = 10;

    /** Logs what the page really looks like (blank? error page? login?) when it does not load. */
    async function describePageState(page) {
        try {
            const title = await page.title().catch(() => '');
            const text = await page.locator('body').innerText({ timeout: 2000 })
                .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 160)).catch(() => '');
            const appRoot = await page.locator('app-root').count().catch(() => -1);
            console.log(`   [page state] url=${page.url()} | title="${title}" | text="${text || 'BLANK PAGE'}" | app-root elements=${appRoot} | recent requests: ${slotApiDiagnostics.slice(-5).join(' | ') || 'none'}`);
        } catch (e) {
            console.log(`   [page state] could not read the page: ${e.message.split('\n')[0]}`);
        }
    }

    /** Reloads the page and reports an HTTP error status (429 = too many requests, 403 = blocked, 5xx = site down). */
    async function reloadAndReport(page) {
        const resp = await page.reload();
        if (resp && resp.status() >= 400) {
            console.log(`⚠️ The site answered the page reload with HTTP ${resp.status()} ${resp.statusText()}. ${resp.status() === 429 ? 'The site is limiting how often this IP may load it.' : ''}`);
        }
    }

    /** 7 seconds plus a random 0-3 seconds, so several bots do not hit the site in lockstep. */
    const refreshPause = () => 7000 + Math.floor(Math.random() * 3000);

    /**
     * Dynamically navigates the Angular Material calendar to the exact month and year
     * specified in TARGET_DATES and selects the exact target day (only if it is enabled).
     */
    async function selectDateOnly(page) {
        console.log('--- STARTING DATE CHECK LOOP (Dynamic Month/Year Navigation) ---');

        const nextMonthBtn = page.locator('button.mat-calendar-next-button[aria-label="Next month"]');
        const prevMonthBtn = page.locator('button.mat-calendar-previous-button[aria-label="Previous month"]');
        const periodHeader = page.locator('.mat-calendar-period-button');
        const calendarToggleButton = page.locator('mat-datepicker-toggle button').first();
        const calendarBody = page.locator('.mat-calendar-body');

        let pickerFails = 0; // consecutive date-check errors (reset as soon as the calendar loads normally)

        while (true) {
            if (STOPPED) throw new Error('Stopped');
            let dateFound = false;
            let stage = 'waiting for the date picker button';
            try {
                await calendarToggleButton.waitFor({ state: 'visible', timeout: DATE_PAGE_WAIT_MS });

                stage = 'opening the date picker';
                if (!await calendarBody.isVisible()) {
                    await calendarToggleButton.click({ timeout: ACTION_TIMEOUT_MS });
                }
                stage = 'waiting for the calendar grid';
                await calendarBody.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
                console.log('Calendar loaded. Checking available dates...');
            pickerFails = 0; // the page works again, so the error streak is over
                stage = 'checking target dates';

                for (const targetDate of TARGET_DATES) {
                    const targetMonthIndex = MONTH_NAMES.indexOf(targetDate.month.toUpperCase());
                    const targetYear = parseInt(targetDate.year, 10);

                    if (targetMonthIndex === -1) {
                        console.log(`⚠️ Invalid month format in TARGET_DATES: "${targetDate.month}". Use 3-letter format (e.g., Nov, Dec, Jan).`);
                        continue;
                    }

                    // Navigate forward or backward up to 12 months until header matches target month & year
                    for (let step = 0; step < 12; step++) {
                        const headerText = (await periodHeader.innerText()).trim().toUpperCase();
                        const currentMonthIndex = MONTH_NAMES.findIndex(m => headerText.includes(m));
                        const yearMatch = headerText.match(/\d{4}/);
                        const currentYear = yearMatch ? parseInt(yearMatch[0], 10) : targetYear;

                        // Stop navigating once calendar displays the target month and year
                        if (currentMonthIndex === targetMonthIndex && currentYear === targetYear) {
                            break;
                        }

                        const isTargetAhead =
                            targetYear > currentYear ||
                            (targetYear === currentYear && targetMonthIndex > currentMonthIndex);

                        if (isTargetAhead) {
                            if (await nextMonthBtn.isDisabled()) {
                                console.log(`⚠️ Cannot navigate further forward to ${targetDate.month} ${targetDate.year} (Next button disabled).`);
                                break;
                            }
                            await nextMonthBtn.click();
                        } else {
                            if (await prevMonthBtn.isDisabled()) {
                                console.log(`⚠️ Cannot navigate further backward to ${targetDate.month} ${targetDate.year} (Previous button disabled).`);
                                break;
                            }
                            await prevMonthBtn.click();
                        }

                        // Brief pause so Angular re-renders the month grid before reading the header again
                        await page.waitForTimeout(250);
                    }

                    // Confirm the calendar really landed on the target month/year before looking for the day
                    const finalHeader = (await periodHeader.innerText()).trim().toUpperCase();
                    const finalYearMatch = finalHeader.match(/\d{4}/);
                    const onTargetMonth =
                        finalHeader.includes(MONTH_NAMES[targetMonthIndex]) &&
                        finalYearMatch &&
                        parseInt(finalYearMatch[0], 10) === targetYear;

                    if (!onTargetMonth) {
                        console.log(`⚠️ Calendar is showing "${finalHeader}", not ${targetDate.month} ${targetDate.year}. Skipping.`);
                        continue;
                    }

                    // Find the exact day cell in the month currently displayed.
                    // The calendar is already on the target month/year (checked above), so the
                    // visible day number is the most reliable thing to match. aria-label is a fallback.
                    const dayNum = String(parseInt(targetDate.day, 10));
                    const labelRegex = buildLabelRegex(targetDate);
                    const cells = page.locator('td.mat-calendar-body-cell');
                    const count = await cells.count();
                    let dateCell = null;
                    let dayExistsButUnavailable = false;
                    const debugRows = [];

                    for (let i = 0; i < count; i++) {
                        const cell = cells.nth(i);
                        const text = ((await cell.innerText()) || '').trim();
                        const label = ((await cell.getAttribute('aria-label')) || '').trim();
                        const cls = (await cell.getAttribute('class')) || '';
                        const ariaDisabled = await cell.getAttribute('aria-disabled');

                        debugRows.push(`text="${text}" | label="${label}" | disabled=${ariaDisabled} | class="${cls}"`);

                        const dayMatches = text === dayNum || labelRegex.test(label);
                        if (!dayMatches) continue;

                        const isDisabled = ariaDisabled === 'true' || cls.includes('mat-calendar-body-disabled');
                        const isAvailable = cls.includes('example-custom-date-class');

                        if (isAvailable && !isDisabled) {
                            dateCell = cell;
                            break;
                        } else {
                            dayExistsButUnavailable = true;
                        }
                    }

                    if (!dateCell) {
                        if (dayExistsButUnavailable) {
                            console.log(`ℹ️ ${targetDate.label} ${targetDate.year} is in the calendar but not available yet.`);
                        } else {
                            console.log(`⚠️ Could not find a cell for ${targetDate.label} ${targetDate.year}. Cells seen:`);
                            debugRows.forEach(r => console.log('   ' + r));
                        }
                    }

                    if (dateCell && await dateCell.isVisible()) {
                        console.log(`✅ Date Available: ${targetDate.label} ${targetDate.year}. Selecting...`);
                        lastDate = `${targetDate.label} ${targetDate.year}`;

                        await Promise.all([
                            page.waitForSelector('.mat-calendar-body', { state: 'hidden', timeout: ACTION_TIMEOUT_MS }),
                            dateCell.click({ force: true, timeout: ACTION_TIMEOUT_MS })
                        ]);

                        dateFound = true;
                        break;
                    }
                }

                if (dateFound) {
                    console.log('--- ✅ DATE SELECTED. Proceeding to Route Selection. ---');
                    return true;
                } else {
                    // Close the calendar with Escape (clicking the toggle again can be blocked by the overlay)
                    await page.keyboard.press('Escape').catch(() => {});
                    console.log('No available dates. Refreshing in about 7 seconds...');
                    await page.waitForTimeout(refreshPause());
                    await reloadAndReport(page);
                }

            } catch (err) {
                if (STOPPED) throw new Error('Stopped');
                console.log(`Error while checking dates (${stage}): ${err.message.split('\n')[0]}`);
                if (page.isClosed()) throw new Error('The page was closed.');
                if (await page.locator('#email').isVisible().catch(() => false)) {
                    throw new Error('Logged out while waiting for a date (login form is showing). Restarting from login.');
                }
                pickerFails++;
                if (pickerFails === 1 || pickerFails % 5 === 0) await describePageState(page);
                console.log(`   (date-check error ${pickerFails}/${DATE_PAGE_MAX_FAILS} in a row)`);
                if (pickerFails >= DATE_PAGE_MAX_FAILS) {
                    // The round fails -> this browser is closed -> a NEW browser opens at the login page,
                    // logs in again and runs every step from the beginning.
                    throw new Error(`The date page failed ${pickerFails} times in a row (last step: ${stage}). Closing this browser and restarting from the login page.`);
                }
                await page.waitForTimeout(refreshPause());
                await reloadAndReport(page);
            }
        }
    }

    /**
     * Selects the route and then picks a slot based on its "Availability: N" number.
     *  - Prefers the first slot that has enough seats for ALL pilgrims still needed.
     *  - If no slot is big enough, picks the slot with the MOST seats (partial booking).
     * Returns { ok, availability } where availability is the seat count of the chosen slot.
     */
    async function selectRouteAndSlot(page, neededCount) {
        console.log('--- STARTING ROUTE SELECTION ---');
        slotApiDiagnostics = [];

        await page.waitForSelector(`${ROUTE_SELECTOR}:not([disabled])`, {
            state: 'visible',
            timeout: ACTION_TIMEOUT_MS,
        });

        await page.selectOption(ROUTE_SELECTOR, ROUTE_VALUE);

        const finalValue = await page.$eval(ROUTE_SELECTOR, el => el.value);

        if (finalValue !== ROUTE_VALUE) {
            console.log(`⚠️ Expected route value "${ROUTE_VALUE}" but got: ${finalValue}. Cannot proceed.`);
            return { ok: false, availability: 0 };
        } else {
            console.log('✅ Route selected: Pamba - Marakkoottam - 4 Kms');
        }

        console.log('--- STARTING SLOT SELECTION ---');

        let slotStage = 'waiting for slot availability';
        try {
            await page.waitForSelector(AVAILABLE_SLOT_SELECTOR, { timeout: SLOW_WAIT_MS });
            slotStage = 'reading slot details';
            await page.waitForTimeout(500); // let all slot cards finish rendering

            const slots = page.locator(TIME_SLOT_CLICK_PARENT);
            const slotCount = await slots.count();

            // Read the time and seat count of every slot
            const slotInfo = [];
            for (let i = 0; i < slotCount; i++) {
                const slot = slots.nth(i);
                const time = ((await slot.locator('.slot-dar-3').first().innerText()) || '').trim();
                const text = (await slot.locator('.slot-dar-5').first().innerText()) || '';
                const m = text.match(/Availability:\s*(\d+)/i);
                const seats = m ? parseInt(m[1], 10) : null; // null = could not read the number
                slotInfo.push({ index: i, time, seats });
            }
            console.log('Slots found: ' + slotInfo.map(s => `${s.time}=${s.seats === null ? '?' : s.seats}`).join(' | '));

            // Ignore slots that clearly have 0 seats
            const usable = slotInfo.filter(s => s.seats === null || s.seats > 0);
            if (usable.length === 0) {
                console.log('⚠️ Route selected, but every slot has 0 seats.');
                return { ok: false, availability: 0 };
            }

            let chosen = null;

            if (AUTO_SLOT_SELECTION === 1) {
                // AUTO: first slot that fits everyone; otherwise the slot with the most seats
                chosen = usable.find(s => s.seats === null || s.seats >= neededCount);
                if (!chosen) {
                    chosen = usable.reduce((best, s) => (s.seats > best.seats ? s : best), usable[0]);
                }
                console.log('Slot mode: AUTO');
            } else {
                // PARTICULAR: only the slots listed in SLOT_PREFERENCES, in priority order
                console.log(`Slot mode: PARTICULAR (${SLOT_PREFERENCES.join(', ')})`);
                const norm = (t) => String(t).replace(/\s+/g, '');
                for (const wanted of SLOT_PREFERENCES) {
                    const match = usable.find(s => norm(s.time) === norm(wanted));
                    if (match) {
                        chosen = match;
                        break;
                    }
                    console.log(`ℹ️ Slot "${wanted}" is not available (missing or 0 seats).`);
                }
                if (!chosen) {
                    console.log('⚠️ None of the preferred slots is available. Round will restart.');
                    return { ok: false, availability: 0 };
                }
            }

            const target = slots.nth(chosen.index);
            if (await target.isVisible()) {
                slotStage = 'clicking the selected slot';
                await target.click();
                const availability = chosen.seats === null ? neededCount : chosen.seats;
                console.log(`✅ Selected slot ${chosen.time} (seats: ${chosen.seats === null ? 'unknown, assuming enough' : chosen.seats}).`);
                return { ok: true, availability, time: chosen.time };
            } else {
                console.log('⚠️ Route selected, but the chosen time slot is not visible.');
                return { ok: false, availability: 0 };
            }

        } catch (e) {
            const [slotCardCount, slotDetailCount] = await Promise.all([
                page.locator('.slot-media').count(),
                page.locator('.slot-dar-5').count(),
            ]);
            console.log(`Slot diagnostics: .slot-media=${slotCardCount}, .slot-dar-5=${slotDetailCount}`);
            console.log(`Slot API activity: ${slotApiDiagnostics.length ? slotApiDiagnostics.join(' | ') : 'no XHR/fetch responses observed'}`);
            console.log(`⚠️ Slot selection failed (${slotStage}): ${e.message.split('\n')[0]}`);
            return { ok: false, availability: 0 };
        }
    }

    const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

    /**
     * Selects the given pilgrim rows (original row numbers from PILGRIM_ROWS).
     * Each pilgrim is remembered by the text of its row, so if the list changes after
     * earlier pilgrims are booked, the right person is still found.
     * Returns [{ row, index }] for the pilgrims actually ticked (original row + current list position).
     */
    async function selectPilgrims(page, rowsToSelect) {
        console.log('--- STARTING PILGRIM SELECTION ---');

        await page.waitForSelector('mat-row', { timeout: ACTION_TIMEOUT_MS });
        const rows = page.locator('mat-row');

        // Read the current list of row texts
        const readRowTexts = async () => {
            const n = await rows.count();
            const texts = [];
            for (let i = 0; i < n; i++) {
                texts.push(normalizeText(await rows.nth(i).innerText()));
            }
            return texts;
        };

        // First time on this page: remember who is in each configured row
        let currentTexts = await readRowTexts();
        for (const rowIndex of PILGRIM_ROWS) {
            if (!(rowIndex in pilgrimIdentity) && currentTexts[rowIndex - 1]) {
                pilgrimIdentity[rowIndex] = currentTexts[rowIndex - 1];
            }
        }

        const selectedRows = [];

        for (const originalRow of rowsToSelect) {
            // Find where this pilgrim is on the page right now
            let currentIndex = originalRow; // default: same row number
            const identity = pilgrimIdentity[originalRow];

            if (identity) {
                const found = currentTexts.findIndex(t => t && (t === identity || t.includes(identity) || identity.includes(t)));
                if (found === -1) {
                    console.log(`⚠️ Pilgrim of original row ${originalRow} is not on the list now. Skipping.`);
                    continue;
                }
                currentIndex = found + 1;
            }

            const checkboxSelector = `//mat-row[${currentIndex}]//mat-checkbox`;
            const inputSelector = `//mat-row[${currentIndex}]//mat-checkbox//input[@type="checkbox"]`;
            const checkbox = page.locator(checkboxSelector);
            const inputElement = page.locator(inputSelector);

            try {
                await inputElement.waitFor({ state: 'attached', timeout: 3000 });

                const isChecked = (await inputElement.getAttribute('aria-checked')) === 'true';

                if (!isChecked) {
                    await checkbox.click();
                    selectedRows.push({ row: originalRow, index: currentIndex });
                    console.log(`✅ Selected Pilgrim (original row ${originalRow}, currently row ${currentIndex})`);
                } else {
                    console.log(`Pilgrim at row ${currentIndex} was already selected or unavailable.`);
                }

            } catch (e) {
                console.log(`⚠️ Pilgrim at row ${currentIndex} not available or failed to click. Error: ${e.message.split('\n')[0]}`);
            }
        }
        console.log(`Total pilgrims selected: ${selectedRows.length}`);
        return selectedRows;
    }

    /**
     * Fills the nominee table. The site shows one nominee row per selected pilgrim,
     * so this loops over every row on the page and fills each one with DEFAULT_NOMINEE
     * (or a per-row entry from NOMINEE_OVERRIDES). Works for any number of pilgrims.
     */
    async function fillNominees(page, picked) {
        console.log('--- STARTING NOMINEE DETAILS ---');

        // The nominee table lists the ticked pilgrims in list order, so table row i belongs to ordered[i].
        const ordered = [...picked].sort((a, b) => a.index - b.index);

        const ROW_SELECTOR = '#nominee-table-wrapper tbody tr';
        const NAME_INPUT = 'input[placeholder="Enter Nominee Name"]';
        const AGE_INPUT = 'input[placeholder="Enter Age"]';

        // Wait for the first nominee row to appear
        await page.waitForSelector(`${ROW_SELECTOR} ${NAME_INPUT}`, { state: 'visible', timeout: ACTION_TIMEOUT_MS });

        // Rows can render one by one, so wait until the row count stops changing
        const rows = page.locator(ROW_SELECTOR);
        let rowCount = await rows.count();
        for (let attempt = 0; attempt < 10; attempt++) {
            await page.waitForTimeout(300);
            const current = await rows.count();
            if (current === rowCount) break;
            rowCount = current;
        }
        console.log(`Found ${rowCount} nominee row(s). Filling all of them.`);

        for (let i = 0; i < rowCount; i++) {
            const rowNumber = i + 1;
            const owner = ordered[i]; // the pilgrim this nominee row belongs to
            const nominee = (owner && NOMINEE_OVERRIDES[owner.row]) || DEFAULT_NOMINEE;
            const row = rows.nth(i);

            const name = String(nominee.name).trim();
            const age = String(nominee.age).trim();
            const relationValue = RELATION_VALUES[String(nominee.relation).trim().toLowerCase()];

            // Validate against the site's own rules before typing
            if (!/^[a-zA-Z ]+$/.test(name) || name.length > 32) {
                console.log(`⚠️ Row ${rowNumber}: name "${name}" must be letters/spaces only, max 32 chars. Skipping this row.`);
                continue;
            }
            if (!/^[0-9]{1,3}$/.test(age)) {
                console.log(`⚠️ Row ${rowNumber}: age "${age}" must be 1 to 3 digits. Skipping this row.`);
                continue;
            }
            if (!relationValue) {
                console.log(`⚠️ Row ${rowNumber}: unknown relation "${nominee.relation}". Use: ${Object.keys(RELATION_VALUES).join(', ')}. Skipping this row.`);
                continue;
            }

            await row.scrollIntoViewIfNeeded();
            await row.locator(NAME_INPUT).fill(name);
            await row.locator(AGE_INPUT).fill(age);
            await row.locator('select').selectOption(relationValue);

            // Blur the last field so Angular marks the row as touched/valid
            await row.locator(AGE_INPUT).press('Tab');

            console.log(`✅ Row ${rowNumber}${owner ? ` (pilgrim row ${owner.row})` : ''} filled: ${name}, ${age}, ${nominee.relation}`);
        }

        console.log('--- ✅ NOMINEE DETAILS DONE ---');
    }

    /**
     * Selects "No" in both contribution sections:
     *   1. Contribute for Pilgrim Relief fund   (radio group name="contribute")
     *   2. Clean Sabarimala Project (Optional)  (radio group name="sanityYesOrNo")
     * Radio ids like #mat-radio-12 change between page loads, so we find each group by its
     * name and pick the "no" option inside it.
     */
    async function selectContributionNo(page) {
        console.log('--- STARTING CONTRIBUTION OPTIONS ---');

        const groups = [
            { name: 'contribute', label: 'Pilgrim Relief fund', required: true },
            { name: 'sanityYesOrNo', label: 'Clean Sabarimala Project', required: false },
        ];

        for (const group of groups) {
            const noButton = page.locator(`mat-radio-group[name="${group.name}"] mat-radio-button[value="no"]`);

            try {
                await noButton.waitFor({ state: 'visible', timeout: group.required ? ACTION_TIMEOUT_MS : 5000 });
            } catch (e) {
                if (group.required) {
                    throw new Error(`"${group.label}" contribution option not found on the page.`);
                }
                console.log(`ℹ️ "${group.label}" option not shown. Skipping.`);
                continue;
            }

            await noButton.scrollIntoViewIfNeeded();
            await noButton.locator('label').click();

            const cls = (await noButton.getAttribute('class')) || '';
            if (cls.includes('mat-radio-checked')) {
                console.log(`✅ Selected "No" for ${group.label}.`);
            } else {
                console.log(`⚠️ Clicked "No" for ${group.label}, but it does not look selected. Check the page.`);
            }
        }

        console.log('--- ✅ CONTRIBUTION OPTIONS DONE ---');
    }

    /**
     * Reads any validation message / toast / popup text currently on the page,
     * so the log shows WHY "Add to Wishlist" did not open the Proceed popup.
     */
    async function pageProblemText(page) {
        try {
            const texts = await page.evaluate(() => {
                const selectors = [
                    'mat-error', '.mat-error', '.error', '.text-danger', '.invalid-feedback',
                    '.alert', '.toast', '.toast-message', '.snack-bar-container', 'simple-snack-bar',
                    '.mat-snack-bar-container', '.swal2-popup', '.mat-dialog-container', '.modal-body',
                    '.ng-invalid:not(form)'
                ];
                const out = [];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach((el) => {
                        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                        if (t) out.push(`${sel}: ${t.slice(0, 150)}`);
                        else if (sel === '.ng-invalid:not(form)') out.push(`invalid field: ${el.tagName.toLowerCase()}${el.getAttribute('placeholder') ? ' [' + el.getAttribute('placeholder') + ']' : ''}`);
                    });
                }
                return out.slice(0, 8);
            });
            return texts.length ? texts.join(' || ') : 'no message found on page';
        } catch (e) {
            return 'could not read page messages';
        }
    }

    /**
     * Looks (in the page and all its frames) for the booking popup (.feedback_form).
     * Returns { success, text, okButton } or null when no popup is showing.
     * success = the popup says "Your transaction is successful ... Transaction ID".
     */
    async function findConfirmationPopup(page) {
        for (const frame of page.frames()) {
            try {
                const popup = frame.locator(CONFIRM_POPUP_SELECTOR).first();
                if (!(await popup.isVisible().catch(() => false))) continue;
                const text = ((await popup.innerText({ timeout: 2000 })) || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                return {
                    success: CONFIRM_SUCCESS_REGEX.test(text),
                    text,
                    okButton: frame.locator(CONFIRM_OK_SELECTOR).filter({ hasText: /^\s*ok\s*$/i }).first(),
                };
            } catch (e) { /* frame not readable yet, try the next one */ }
        }
        return null;
    }

    /**
     * Waits (up to FEEDBACK_WAIT_MS) for the booking popup. This is the ONLY success signal:
     *   - popup saying "transaction is successful"  -> booked (Transaction ID is logged, OK is clicked)
     *   - a popup saying anything else              -> failed right away (its text is logged)
     *   - no popup at all                           -> failed after the wait
     * Returns true only for a confirmed booking.
     */
    async function verifyBookingSuccess(page) {
        console.log('--- VERIFYING BOOKING (waiting for the "Booking Confirmation" popup) ---');
        lastTransactionId = '';
        const deadline = Date.now() + FEEDBACK_WAIT_MS;

        while (Date.now() < deadline) {
            if (STOPPED) throw new Error('Stopped');

            const popup = await findConfirmationPopup(page);
            if (popup && popup.success) {
                const idMatch = popup.text.match(/transaction id\s*:?\s*(\d+)/i);
                lastTransactionId = idMatch ? idMatch[1] : '';
                console.log(`✅ Booking Confirmation popup appeared: ${popup.text.slice(0, 160)}`);
                console.log(`✅ Booking confirmed. Transaction ID: ${lastTransactionId || 'not found in popup'}`);
                try {
                    await popup.okButton.click({ timeout: 5000 });
                    console.log('Clicked "OK" on the Booking Confirmation popup.');
                } catch (e) {
                    console.log(`ℹ️ Could not click OK on the popup (booking is still counted): ${e.message.split('\n')[0]}`);
                }
                return true;
            }
            if (popup && !popup.success) {
                console.log(`⚠️ A popup appeared but it does NOT confirm the booking. Popup says: ${popup.text.slice(0, 300)}`);
                return false;
            }

            await page.waitForTimeout(1000);
        }

        const url = page.url();
        const text = normalizeText(await page.locator('body').innerText().catch(() => '')).slice(0, 300);
        console.log(`Final page URL: ${url}`);
        console.log(`Final page text: ${text || 'could not read'}`);
        console.log('⚠️ The Booking Confirmation popup never appeared, so this booking is treated as FAILED.');
        return false;
    }

    /**
     * Prints everything needed to tell a BOT problem from a WEBSITE problem when
     * "Add to Wishlist" does nothing: which form fields the site itself marks invalid,
     * the state of the button, the slot cards, and the latest wishlist requests.
     * Also saves a screenshot in ./debug/.
     */
    async function dumpWishlistDiagnostics(page, label) {
        try {
            const info = await page.evaluate(() => {
                const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 40);
                const invalid = [...document.querySelectorAll('.ng-invalid:not(form)')].map((el) =>
                    `${el.tagName.toLowerCase()}[name=${el.getAttribute('name') || ''}|formcontrolname=${el.getAttribute('formcontrolname') || ''}|placeholder=${el.getAttribute('placeholder') || ''}] value="${clean(el.value)}"`);
                const route = document.querySelector('select[name="reportingPlace"]');
                const addBtn = [...document.querySelectorAll('button#regi_continue')].find((b) => /add to wishlist/i.test(b.innerText));
                const slots = [...document.querySelectorAll('.slot-media')].slice(0, 6).map((el) => `${clean(el.innerText)} => class="${el.className}"`);
                const dateInput = document.querySelector('input.mat-datepicker-input, input[matinput]');
                return {
                    invalid,
                    route: route ? `value="${route.value}" class="${route.className}"` : 'no route select on page',
                    date: dateInput ? `"${dateInput.value}"` : 'no date input found',
                    addBtn: addBtn ? `disabled=${addBtn.disabled} class="${addBtn.className}"` : 'Add to Wishlist button not found',
                    slots,
                    errors: [...document.querySelectorAll('.text-danger, mat-error')].map((el) => clean(el.innerText)).filter(Boolean).length,
                };
            });
            console.log(`   [wishlist diagnostics: ${label}] route: ${info.route}`);
            console.log(`   [wishlist diagnostics: ${label}] date input: ${info.date}`);
            console.log(`   [wishlist diagnostics: ${label}] Add to Wishlist button: ${info.addBtn}`);
            console.log(`   [wishlist diagnostics: ${label}] fields the SITE marks invalid: ${info.invalid.length ? info.invalid.join(' || ') : 'none'}`);
            console.log(`   [wishlist diagnostics: ${label}] slot cards: ${info.slots.length ? info.slots.join(' || ') : 'none on page'}`);
            console.log(`   [wishlist diagnostics: ${label}] last requests: ${slotApiDiagnostics.slice(-8).join(' | ') || 'none seen'}`);
            const fs = require('fs');
            fs.mkdirSync('debug', { recursive: true });
            const file = `debug/bot${botId}-wishlist-${Date.now()}.png`;
            await page.screenshot({ path: file, fullPage: true, timeout: 5000 });
            console.log(`   [wishlist diagnostics: ${label}] screenshot saved: ${file}`);
        } catch (e) {
            console.log(`   [wishlist diagnostics] could not collect: ${e.message.split('\n')[0]}`);
        }
    }

    // Messages the site shows (in a .error-msg box) right after "Add to Wishlist":
    //  - PENDING_SLOT: the slot cannot be booked right now  -> retry from DATE SELECTION (same browser)
    //  - BLOCKED:      a previous booking was not availed   -> skip this attempt, close the browser, restart from LOGIN
    // If neither message shows up, the checkout continues with the Proceed button as usual.
    const MSG_PENDING_SLOT = /already having pending booking|sufficient quota is not available/i;
    const MSG_BLOCKED = /cannot make transaction until you avail previous booking/i;

    /**
     * After "Add to Wishlist": waits up to 8 s for the Proceed popup or for one of the site's messages.
     * Returns { type: 'popup' | 'pending-slot' | 'blocked' | 'none', text }.
     */
    async function waitForPopupOrMessage(page, proceedButton) {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            if (STOPPED) throw new Error('Stopped');
            const texts = await page.locator('.error-msg:visible').allInnerTexts().catch(() => []);
            const text = texts.join(' ').replace(/\s+/g, ' ').trim();
            if (text && MSG_PENDING_SLOT.test(text)) return { type: 'pending-slot', text };
            if (text && MSG_BLOCKED.test(text)) return { type: 'blocked', text };
            if (await proceedButton.isVisible().catch(() => false)) return { type: 'popup', text: '' };
            await page.waitForTimeout(250);
        }
        return { type: 'none', text: '' };
    }

    /**
     * Handles the wishlist and proceed steps, then CONFIRMS the booking.
     * Throws a normal error if anything is not confirmed, so the round restarts,
     * the wishlist is cleared, and the same pilgrims are tried again.
     */
    async function handleFinalSteps(page) {
        console.log('--- STARTING FINAL CHECKOUT STEPS ---');

        const firstProceedButton = page.locator('button:visible:has-text("Proceed")').first();

        // ---- Phase 1: Add to Wishlist -> wait for the Proceed popup (retry the click if needed) ----
        let popupShown = false;
        for (let attempt = 1; attempt <= ADD_TO_WISHLIST_ATTEMPTS && !popupShown; attempt++) {
            if (STOPPED) throw new Error('Stopped');
            try {
                const addBtn = page.locator('button#regi_continue:has-text("Add to Wishlist")');
                await addBtn.scrollIntoViewIfNeeded();
                await addBtn.click({ timeout: ACTION_TIMEOUT_MS });
                console.log(`Clicked "Add to Wishlist" (attempt ${attempt}/${ADD_TO_WISHLIST_ATTEMPTS}).`);
            } catch (e) {
                console.log(`⚠️ Could not click "Add to Wishlist" (attempt ${attempt}): ${e.message.split('\n')[0]}`);
                continue;
            }

            const outcome = await waitForPopupOrMessage(page, firstProceedButton);

            if (outcome.type === 'popup') {
                popupShown = true;
                break;
            }

            if (outcome.type === 'pending-slot') {
                console.log(`⚠️ Site message: ${outcome.text}`);
                const e = new Error('Pending booking for the same slot / quota not available. Retrying from date selection.');
                e.restartFromDate = true;
                e.siteMessage = outcome.text;
                throw e;
            }

            if (outcome.type === 'blocked') {
                console.log(`🚫 Site message: ${outcome.text}`);
                const e = new Error('Previous booking not availed, so these pilgrim(s) cannot be booked now. Skipping them for now.');
                e.skipUser = true;
                e.siteMessage = outcome.text;
                throw e;
            }

            // Neither message and no popup: unknown problem.
            console.log(`⚠️ Proceed popup did not appear after attempt ${attempt}. Page says: ${await pageProblemText(page)}`);
            await dumpWishlistDiagnostics(page, 'popup missing');
            // Do NOT click again or touch the form: after a successful "Add to Wishlist" the site
            // resets the booking form (empty route/date, disabled button), so retrying here is useless
            // and the wishlist is not cleared. Restart from the login page instead; the wishlist check
            // right after login either finishes this booking (date matches + slot available) or clears it.
            const siteAccepted = slotApiDiagnostics.some((l) => /addToWishlist\s+2\d\d/i.test(l));
            throw new Error(siteAccepted
                ? 'The site accepted Add to Wishlist but the Proceed popup did not open (the item may be in the wishlist). Restarting from the login page; the wishlist is checked there.'
                : 'Add to Wishlist did not open the Proceed popup. Restarting from the login page.');
        }

        if (!popupShown) {
            const visibleButtons = (await page.locator('button:visible').allInnerTexts())
                .map((text) => text.trim())
                .filter(Boolean)
                .slice(0, 10);
            console.log(`Current URL: ${page.url()}`);
            console.log(`Visible buttons: ${visibleButtons.join(' | ') || 'none'}`);
            throw new Error('Could not click Add to Wishlist. Restarting from the login page.');
        }

        await checkoutFromProceed(page, firstProceedButton);
    }

    /**
     * first "Proceed" (the Add-to-Wishlist popup OR the wishlist box) -> payment gateway page
     * -> its single "Proceed" button -> "Booking Confirmation" popup.
     * Throws unless the booking is confirmed by that popup.
     */
    async function checkoutFromProceed(page, firstProceedButton) {
        // ---- Phase 2: first Proceed -> payment page -> final Proceed ----
        try {
            await firstProceedButton.click();
            console.log('Clicked first "Proceed". Waiting for the payment page...');

            await page.waitForSelector('button#regi_continue:has-text("Proceed")', {
                state: 'visible',
                timeout: SLOW_WAIT_MS,
            });
            console.log('Payment page Proceed button is visible.');

            // Click the final "Proceed" button on the payment gateway
            await page.click('button#regi_continue:has-text("Proceed")');
            console.log('Clicked final "Proceed" button on Payment Gateway.');
        } catch (error) {
            const visibleButtons = (await page.locator('button:visible').allInnerTexts())
                .map((text) => text.trim())
                .filter(Boolean)
                .slice(0, 10);
            console.log(`Payment page Proceed button did not appear. Current URL: ${page.url()}`);
            console.log(`Visible buttons: ${visibleButtons.join(' | ') || 'none'}`);
            throw new Error(`Checkout did not reach the payment step: ${error.message.split('\n')[0]}`);
        }

        // ---- Phase 3: confirm the booking really happened ----
        const confirmed = await verifyBookingSuccess(page);
        if (!confirmed) {
            throw new Error('Booking not confirmed: the Booking Confirmation popup ("transaction is successful") did not appear. These pilgrims stay in the remaining list and will be booked again.');
        }

        console.log('--- ✅ BOOKING CONFIRMED FOR THIS ROUND ---');
    }


    // -------------------------------------------------------------------------
    // --- 4. EXECUTION ---
    // -------------------------------------------------------------------------

    let HEADLESS = true;
    let USE_INSTALLED_CHROME = false;

    /** Called by server.js. cfg comes from the UI. */
    async function run(cfg, logFn, progFn) {
        LOG = logFn;
        progressFn = progFn || (() => {});
        console.log('Build: status-panel v2 (bot.js)');
        STOPPED = false;
        USERNAME = cfg.username; PASSWORD = cfg.password;
        TARGET_DATES = cfg.dates;
        PILGRIM_ROWS = cfg.pilgrimRows;
        DEFAULT_NOMINEE = cfg.nominee;
        NOMINEE_OVERRIDES = cfg.overrides || {};
        ROUTE_VALUE = cfg.routeValue || '1';
        AUTO_SLOT_SELECTION = cfg.slotMode === 'auto' ? 1 : 0;
        SLOT_PREFERENCES = cfg.slots || [];
        MAX_RETRIES = cfg.maxRetries || 5;
        RETRY_DELAY_MS = (cfg.retryDelaySec || 5) * 1000;
        COOLDOWN_MS = (cfg.cooldownSec || 60) * 1000;
        HEADLESS = cfg.headless !== false;
        USE_INSTALLED_CHROME = !!cfg.useInstalledChrome;
        await runBookingBot();
    }

    function stop() {
        STOPPED = true;
        if (activeBrowser) activeBrowser.close().catch(() => {});
    }

    return { run, stop };
}

module.exports = { createBot };
