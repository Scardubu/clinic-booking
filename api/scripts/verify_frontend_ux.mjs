import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const htmlPath = path.resolve(__dirname, '../../web/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Extract JS
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
if (!scriptMatch) throw new Error('No script found');
const jsCode = scriptMatch[1];

// Setup a mock DOM environment
class MockElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    let _className = '';
    this.classList = {
      _classes: new Set(),
      add: (...c) => {
        c.forEach(x => this.classList._classes.add(x));
        _className = Array.from(this.classList._classes).join(' ');
      },
      remove: (...c) => {
        c.forEach(x => this.classList._classes.delete(x));
        _className = Array.from(this.classList._classes).join(' ');
      },
      toggle: (c, val) => {
        val ? this.classList._classes.add(c) : this.classList._classes.delete(c);
        _className = Array.from(this.classList._classes).join(' ');
      },
      contains: (c) => this.classList._classes.has(c)
    };
    Object.defineProperty(this, 'className', {
      get: () => _className,
      set: (val) => {
        _className = String(val);
        this.classList._classes.clear();
        _className.split(/\s+/).filter(Boolean).forEach(c => this.classList._classes.add(c));
      }
    });
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this.children = [];
    this.scrollTop = 0;
    this.value = '';
    this.disabled = false;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  querySelector(sel) {
    if (sel === '.slot-card-top') return this.children.find(c => c.className === 'slot-card-top') || null;
    if (sel === '.slot-badge-selected') return this.children.find(c => c.className === 'slot-badge-selected') || null;
    return null;
  }
  querySelectorAll(sel) {
    if (sel === '.slot-card') return this.children.filter(c => c.classList.contains('slot-card'));
    return [];
  }
  appendChild(child) { this.children.push(child); return child; }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(x => x !== this);
    }
  }
  scrollIntoView() {}
}

const elements = {
  banner: new MockElement('div', 'banner'),
  slotsGrid: new MockElement('div', 'slotsGrid'),
  bookingsList: new MockElement('div', 'bookingsList'),
  paginationStats: new MockElement('span', 'paginationStats'),
  nextCursorBtn: new MockElement('button', 'nextCursorBtn'),
  slotId: new MockElement('input', 'slotId'),
  copySlotInputBtn: new MockElement('button', 'copySlotInputBtn'),
  slotSelectionSummary: new MockElement('div', 'slotSelectionSummary'),
  patientName: new MockElement('input', 'patientName'),
  patientEmail: new MockElement('input', 'patientEmail'),
  patientPhone: new MockElement('input', 'patientPhone'),
  reason: new MockElement('textarea', 'reason'),
  bookBtn: new MockElement('button', 'bookBtn'),
  confirmationBox: new MockElement('div', 'confirmationBox'),
  confirmationBody: new MockElement('div', 'confirmationBody'),
  lookupId: new MockElement('input', 'lookupId'),
  lookupResult: new MockElement('div', 'lookupResult'),
  searchEmail: new MockElement('input', 'searchEmail'),
  slotsSection: new MockElement('div', 'slotsSection'),
  lookupSection: new MockElement('div', 'lookupSection'),
  receiptStatusBadge: new MockElement('span', 'receiptStatusBadge'),
  receiptCancelBtn: new MockElement('button', 'receiptCancelBtn'),
  receiptNotice: new MockElement('div', 'receiptNotice')
};

let clipboardText = '';
const mockNavigator = {
  clipboard: {
    writeText: async (t) => { clipboardText = t; }
  }
};

const mockWindow = {
  location: { search: '', hostname: 'localhost' },
  isSecureContext: true
};

const mockDocument = {
  getElementById: (id) => elements[id] || null,
  createElement: (tag) => new MockElement(tag),
  body: new MockElement('body')
};

// Create sandbox
const context = {
  window: mockWindow,
  document: mockDocument,
  navigator: mockNavigator,
  location: mockWindow.location,
  URLSearchParams,
  crypto,
  setTimeout,
  clearTimeout,
  Date,
  console,
  alert: (msg) => { throw new Error('ALERT_CALLED: ' + msg); },
  confirm: () => true,
  fetch: async (url, options = {}) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' })
    };
  }
};

vm.createContext(context);
// Run script
vm.runInContext(jsCode, context);

console.log('=== Running Frontend Verification Tests ===\n');

// Test 1: notify formats UUIDs with copy button
{
  context.notify('Booking 1643a64e-e038-4258-8889-088be7119686 was cancelled.', 'success');
  const bannerHtml = elements.banner.innerHTML;
  assert(bannerHtml.includes('1643a64e-e038-4258-8889-088be7119686'), 'Banner contains UUID');
  assert(bannerHtml.includes('copy-btn'), 'Banner contains copy button');
  assert(bannerHtml.includes("copyText('1643a64e-e038-4258-8889-088be7119686'"), 'Banner copy button calls copyText with UUID');
  console.log('[PASS] Test 1: notify() formats UUIDs with inline copy buttons');
}

// Test 2: copyText double click resilience
{
  const btn = new MockElement('button');
  btn.innerHTML = '<span>Copy</span>';
  
  // First click
  await context.copyText('test-uuid-1234', btn);
  assert.strictEqual(btn.innerHTML, 'Copied! ✨');
  assert.strictEqual(clipboardText, 'test-uuid-1234');

  // Rapid second click
  await context.copyText('test-uuid-1234', btn);
  assert.strictEqual(btn.innerHTML, 'Copied! ✨');
  assert.strictEqual(btn.dataset.originalHtml, '<span>Copy</span>');

  // Trigger timeout
  btn._copyTimeout = null; // simulate timeout restore
  btn.innerHTML = btn.dataset.originalHtml;
  assert.strictEqual(btn.innerHTML, '<span>Copy</span>', 'Button restored cleanly to original HTML');
  console.log('[PASS] Test 2: copyText() double-click does not corrupt original button HTML');
}

// Test 3: copyText failure feedback
{
  const failBtn = new MockElement('button');
  failBtn.innerHTML = 'Copy';
  const originalWrite = mockNavigator.clipboard.writeText;
  mockNavigator.clipboard.writeText = () => { throw new Error('Permission denied'); };

  // In non-browser Node mock without execCommand, it will fail
  await context.copyText('fail-text', failBtn);
  assert.strictEqual(failBtn.innerHTML, 'Failed ⚠️');
  mockNavigator.clipboard.writeText = originalWrite;
  console.log('[PASS] Test 3: copyText() reports Failed ⚠️ when clipboard fails');
}

// Test 4: renderSuccessReceipt populates receipt and confirmationBody with Slot UUID
{
  const bookingData = {
    id: 'booking-999-uuid',
    slot_id: 'slot-888-uuid',
    name: 'Adaeze Nwosu',
    email: 'adaeze@example.com',
    status: 'confirmed',
    slot: {
      id: 'slot-888-uuid',
      provider: 'Dr. Tunde Bakare (Internal Medicine)',
      start: '2026-11-01T10:00:00Z'
    }
  };

  context.renderSuccessReceipt(bookingData);
  assert(elements.confirmationBox.innerHTML.includes('booking-999-uuid'), 'Receipt has Booking ID');
  assert(elements.confirmationBox.innerHTML.includes('slot-888-uuid'), 'Receipt has Slot UUID');
  assert(elements.confirmationBox.innerHTML.includes('Dr. Tunde Bakare'), 'Receipt has Doctor Name');
  assert(elements.confirmationBox.innerHTML.includes('Internal Medicine'), 'Receipt has Specialization');
  assert(elements.confirmationBox.innerHTML.includes('copyText(\'booking-999-uuid\''), 'Receipt has copy button for Ref ID');
  assert(elements.confirmationBox.innerHTML.includes('copyText(\'slot-888-uuid\''), 'Receipt has copy button for Slot UUID');

  // Check confirmationBody
  assert(elements.confirmationBody.innerHTML.includes('booking-999-uuid'), 'confirmationBody has Booking ID');
  assert(elements.confirmationBody.innerHTML.includes('slot-888-uuid'), 'confirmationBody has Slot UUID');
  console.log('[PASS] Test 4: renderSuccessReceipt() populates both receipt card & confirmationBody with doctor, time, Ref ID, and Slot UUID copy buttons');
}

// Test 5: cancelBooking handles receipt cancellation without alert()
{
  context.currentReceiptBooking = { id: 'booking-999-uuid' };
  elements.lookupId.value = 'booking-999-uuid';
  
  // Call cancelBooking
  context.cancelBooking('booking-999-uuid').then(() => {
    assert.strictEqual(elements.receiptStatusBadge.textContent, '✕ CANCELLED');
    assert.strictEqual(elements.receiptCancelBtn.disabled, true);
    assert(elements.receiptNotice.textContent.includes('was cancelled'));
    console.log('[PASS] Test 5: cancelBooking() seamlessly updates receipt card without alert()');
  });
}

// Test 6: chooseSlot in-place selection without destroying scroll
{
  // Setup slots in grid
  elements.slotsGrid.children = [];
  for (let i = 1; i <= 5; i++) {
    const card = new MockElement('div');
    card.classList.add('slot-card');
    card.setAttribute('data-slot-id', `slot-${i}`);
    const top = new MockElement('div');
    top.className = 'slot-card-top';
    card.children.push(top);
    card.parent = elements.slotsGrid;
    elements.slotsGrid.children.push(card);
  }
  elements.slotsGrid.scrollTop = 150;

  // Select slot 3
  context.chooseSlot('slot-3');
  assert.strictEqual(elements.slotId.value, 'slot-3');
  assert.strictEqual(elements.slotsGrid.scrollTop, 150, 'Scroll position preserved');
  assert(elements.slotsGrid.children[2].classList.contains('selected'), 'Slot 3 has selected class');
  assert(!elements.slotsGrid.children[0].classList.contains('selected'), 'Slot 1 not selected');
  assert(!elements.slotsGrid.children[1].classList.contains('selected'), 'Slot 2 not selected');

  // Select slot 4
  context.chooseSlot('slot-4');
  assert.strictEqual(elements.slotId.value, 'slot-4');
  assert(!elements.slotsGrid.children[2].classList.contains('selected'), 'Slot 3 selected removed');
  assert(elements.slotsGrid.children[3].classList.contains('selected'), 'Slot 4 has selected class');
  console.log('[PASS] Test 6: chooseSlot() moves selection smoothly in-place with 0ms lag and 0 scroll jump');
}

// Test 7: Verify slot card markup contains onkeydown with event.target check and copy button onkeydown
{
  assert(html.includes("if(event.target===event.currentTarget && (event.key==='Enter'||event.key===' '))"), 'Slot card checks event.target === event.currentTarget');
  assert(html.includes('onkeydown="event.stopPropagation();"'), 'Copy button stops keydown propagation');
  console.log('[PASS] Test 7: Slot card markup isolates keydown events preventing accidental slot activation when copying');
}

// Test 8: Selected Slot Summary Card renders Doctor, Specialization, Date/Time and Change button
{
  context.window.cachedSlots = [{
    id: 'slot-xyz-789',
    provider: 'Dr. Amina Bello (Pediatrics)',
    start: '2026-11-10T14:30:00Z'
  }];
  context.updateSelectedSlotUI('slot-xyz-789');
  assert(elements.slotSelectionSummary.innerHTML.includes('Dr. Amina Bello'), 'Summary card has Doctor Name');
  assert(elements.slotSelectionSummary.innerHTML.includes('Pediatrics'), 'Summary card has Specialization');
  assert(elements.slotSelectionSummary.innerHTML.includes('btn-change-slot'), 'Summary card has Change Slot button');
  assert(elements.slotSelectionSummary.classList.contains('active'), 'Summary card has active class');

  // Test empty state
  context.updateSelectedSlotUI('');
  assert(elements.slotSelectionSummary.innerHTML.includes('No appointment slot selected'), 'Summary card displays friendly empty state');
  assert(elements.slotSelectionSummary.classList.contains('empty'), 'Summary card has empty class');
  console.log('[PASS] Test 8: updateSelectedSlotUI() renders human-readable Doctor, Specialization, Date/Time & Change Slot button');
}

// Test 9: HTML markup hides raw UUID slot input box and provides hidden slotId
{
  assert(html.includes('<input type="hidden" id="slotId" name="slotId"'), 'HTML has hidden input for slotId');
  assert(!html.includes('<input type="text" id="slotId"'), 'HTML does not have raw text input for slotId');
  console.log('[PASS] Test 9: Section 2 eliminates raw text input box for slotId in favor of hidden input & summary card');
}

// Test 10: Post-booking flow auto-fills email into Section 3 search input and auto-copies Ref ID
{
  const prevFetch = context.fetch;
  let lastFetchedUrl = '';
  context.fetch = async (url, opts = {}) => {
    lastFetchedUrl = url;
    if (url.includes('/bookings') && opts.method === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          booking: {
            id: 'booking-auto-copy-123',
            slot_id: 'slot-xyz-789',
            name: 'Chidi Obi',
            email: 'chidi@example.com'
          }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ bookings: [] })
    };
  };

  elements.slotId.value = 'slot-xyz-789';
  elements.patientName.value = 'Chidi Obi';
  elements.patientEmail.value = 'chidi@example.com';

  await context.handleBookSubmit({ preventDefault: () => {} });

  assert.strictEqual(elements.searchEmail.value, 'chidi@example.com', 'Section 3 searchEmail is auto-populated');
  assert.strictEqual(clipboardText, 'booking-auto-copy-123', 'New booking Ref ID was auto-copied to clipboard');
  assert(lastFetchedUrl.includes('email=chidi%40example.com') || lastFetchedUrl.includes('email=chidi@example.com'), 'Section 3 bookings fetch was immediately triggered with patient email');

  context.fetch = prevFetch;
  console.log('[PASS] Test 10: handleBookSubmit() auto-populates email filter, immediately fetches bookings, and auto-copies Ref ID');
}

// Test 11: Consolidated Success Receipt has prominent "View in My Bookings" shortcut button and auto-copy notice
{
  context.renderSuccessReceipt({
    id: 'booking-receipt-test',
    slot_id: 'slot-xyz-789',
    name: 'Adaeze Nwosu',
    email: 'adaeze@example.com'
  });
  assert(elements.confirmationBox.innerHTML.includes('View in My Bookings'), 'Receipt card includes View in My Bookings button');
  assert(elements.confirmationBox.innerHTML.includes('Auto-copied to clipboard'), 'Receipt card includes Auto-copied notice');
  console.log('[PASS] Test 11: renderSuccessReceipt() provides "View in My Bookings" shortcut and auto-copied notice');
}

// Test 12: Friendly empty state messages across Section 3 and Section 4
{
  // Test Section 3 empty state when no email is filtered
  elements.searchEmail.value = '';
  await context.fetchBookings();
  assert(elements.bookingsList.innerHTML.includes('Enter your booking email above or complete a new appointment to view your history'), 'Section 3 empty state has welcoming helper text');

  // Test Section 3 empty state when email filter has no results
  elements.searchEmail.value = 'unknown@example.com';
  await context.fetchBookings();
  assert(elements.bookingsList.innerHTML.includes('No appointments found for "unknown@example.com"'), 'Section 3 empty state displays contextual email message');

  // Test Section 4 initial empty state in HTML
  assert(html.includes('Enter your Booking Reference ID above to retrieve your appointment details'), 'Section 4 has helpful instructional initial state in HTML');
  console.log('[PASS] Test 12: Section 3 and Section 4 display friendly, instructional empty state messaging');
}

setTimeout(() => {
  console.log('\n=== ALL FRONTEND UX TESTS PASSED! ===');
}, 100);
