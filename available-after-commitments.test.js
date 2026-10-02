'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const TODAY = '2026-10-03';

function extractFunction(name){
  const signature = `function ${name}(`;
  const start = html.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index++){
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`unclosed function ${name}`);
}

const dateHelpers = [
  'addMonths', 'addInterval', 'parseISO', 'generateOccurrenceDates',
  'computeItemBounds', 'dateISO', 'overdueOccurrence',
  'hasConfirmedOccurrenceReceipt', 'computeUnpaidCommittedSpending'
].map(extractFunction).join('\n');

function expense({ id = 'expense-1', date, amount, freq = 'once', end = { type:'never', date:'', count:'' } }){
  return { id, date, amount, freq, end, mode:'fixed', min:0, max:0, history:[] };
}

function metric({ savings = 0, expenses = [], receiptLog = [], horizonMonths = 12, income = [] } = {}){
  const timestamp = new Date(2026, 9, 3, 12).getTime();
  class FrozenDate extends Date {
    constructor(...args){ super(...(args.length ? args : [timestamp])); }
    static now(){ return timestamp; }
  }
  const data = { savings, expenses, receiptLog, horizonMonths, income };
  const context = vm.createContext({
    data,
    Date:FrozenDate,
    todayISO:() => TODAY
  });
  vm.runInContext(`${dateHelpers}\nthis.unpaid = computeUnpaidCommittedSpending();`, context);
  const unpaid = context.unpaid;
  return { unpaid, available:savings - unpaid };
}

test('1. no commitments leaves actual savings unchanged', () => {
  assert.equal(metric({ savings:1000 }).available, 1000);
});

test('2. one-time spending on next month end is included', () => {
  assert.equal(metric({ savings:1000, expenses:[expense({ date:'2026-11-30', amount:125 })] }).available, 875);
});

test('3. one-time spending after next month end is excluded', () => {
  assert.equal(metric({ savings:1000, expenses:[expense({ date:'2026-12-01', amount:125 })] }).available, 1000);
});

test('4. every recurring occurrence through next month end is counted', () => {
  assert.equal(metric({ savings:2000, expenses:[expense({ date:'2026-10-10', amount:100, freq:'weekly' })] }).available, 1200);
});

test('5. recurring occurrences after next month end are excluded', () => {
  assert.equal(metric({ savings:1000, expenses:[expense({ date:'2026-11-28', amount:100, freq:'weekly' })] }).available, 900);
});

test('6. latest overdue occurrence is included once, with future occurrences', () => {
  assert.equal(metric({ savings:1000, expenses:[expense({ date:'2026-08-03', amount:200, freq:'monthly' })] }).available, 600);
});

test('7. exact receipt-linked occurrence is excluded', () => {
  const item = expense({ id:'paid-once', date:'2026-11-30', amount:125 });
  assert.equal(metric({ savings:1000, expenses:[item], receiptLog:[{ sourceExpenseId:item.id, sourceScheduledDate:item.date }] }).available, 1000);
});

test('8. fixed-count spending counts only occurrences remaining in the window', () => {
  const item = expense({ date:'2026-09-03', amount:100, freq:'monthly', end:{ type:'count', count:3 } });
  assert.equal(metric({ savings:1000, expenses:[item] }).available, 800);
});

test('9. date-ended spending stops at its configured end date', () => {
  const item = expense({ date:'2026-10-15', amount:50, freq:'weekly', end:{ type:'date', date:'2026-11-01', count:'' } });
  assert.equal(metric({ savings:1000, expenses:[item] }).available, 850);
});

test('10. commitments can make available savings negative', () => {
  assert.equal(metric({ savings:50, expenses:[expense({ date:'2026-11-30', amount:125 })] }).available, -75);
});

test('11. selected chart horizon does not affect this metric', () => {
  const expenses = [expense({ date:'2026-10-10', amount:100, freq:'weekly' })];
  assert.equal(metric({ savings:2000, expenses, horizonMonths:1 }).available, 1200);
  assert.equal(metric({ savings:2000, expenses, horizonMonths:60 }).available, 1200);
});

test('12. distant one-time spending neither counts nor extends this metric window', () => {
  const expenses = [
    expense({ id:'recurring', date:'2026-10-10', amount:100, freq:'monthly' }),
    expense({ id:'distant', date:'2027-02-01', amount:1000 })
  ];
  assert.equal(metric({ savings:5000, expenses, horizonMonths:1 }).available, 4800);
});

test('13. future income is not deducted', () => {
  assert.equal(metric({ savings:500, income:[{ amount:10000, date:'2026-10-10' }] }).available, 500);
});

test('14. duplicate expense/date keys are counted once', () => {
  const first = expense({ id:'duplicate', date:'2026-11-30', amount:125 });
  const duplicate = { ...first };
  assert.equal(metric({ savings:1000, expenses:[first, duplicate] }).available, 875);
});

test('dashboard uses the independent metric and concise window label', () => {
  assert.match(html, /computeUnpaidCommittedSpending\(\);/);
  assert.match(html, /After unpaid commitments through next month/);
});