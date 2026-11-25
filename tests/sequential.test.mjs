import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import stats from '../stats.js';

const fixture = name => {
  const lines = readFileSync(new URL(`./reference/${name}.csv`, import.meta.url), 'utf8').trim().split('\n');
  const keys = lines.shift().split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [keys[i], value === '' ? null : Number.isNaN(Number(value)) ? value : Number(value)])));
};
const close = (actual, expected, label, tolerance = 2e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);

test('binomial CDF agrees with closed forms', () => {
  close(stats.binomialCdf(0, 10, .3), .7 ** 10, 'P(X=0)');
  close(stats.binomialCdf(3, 3, .4), 1, 'all');
  close(stats.binomialCdf(2, 4, .5), 11 / 16, 'half');
});

for (const [i, r] of fixture('vaccine').entries()) {
  test(`R exact vaccine-efficacy reference ${i + 1}: VE ${r.ve} vs ${r.ve0}, ratio ${r.ratio}`, () => {
    const p = { ve: r.ve, ve0: r.ve0, ratio: r.ratio, alpha: r.alpha, power: r.target };
    const out = stats.vaccineSampleSize(p);
    assert.deepEqual([out.total, out.critical, out.first], [r.total, r.critical, r.first]);
    close(out.power, r.achieved, 'achieved'); close(out.size, r.size, 'size'); close(out.firstPower, r.firstPower, 'first power');
    close(out.boundaryVE, r.boundaryVE, 'boundary VE', 1e-12);
    if (r.previous !== null) close(stats.vaccinePowerAt({ ...p, n: r.total - 1 }).power, r.previous, 'previous');
    assert.ok(out.size <= r.alpha);
  });
}

for (const [i, r] of fixture('negative-binomial').entries()) {
  test(`R negative binomial reference ${i + 1}: μ0 ${r.mu0}, RR ${r.rr}, k ${r.k}, RR0 ${r.rr0}`, () => {
    const p = { rate0: r.mu0, rateRatio: r.rr, dispersion: r.k, followUp: r.t, nullRatio: r.rr0, ratio: r.ratio, alpha: r.alpha, power: r.target };
    const out = stats.rateRatioSampleSize(p);
    assert.deepEqual([out.n, out.n2, out.total], [r.n, r.n2, r.total]);
    close(out.power, r.achieved, 'achieved');
    if (r.previous !== null) { const n = r.n - 1; close(stats.rateRatioPowerAt({ ...p, n, n2: Math.max(2, Math.round(n * r.ratio)) }).power, r.previous, 'previous'); }
  });
}

for (const [i, r] of fixture('group-sequential').entries()) {
  test(`R group sequential reference ${i + 1}: ${r.type}, ${r.looks} looks, ${r.family}${r.type === 'futility' ? '/' + r.lfamily : ''}, β ${r.beta}`, () => {
    const fractions = r.looks === 2 ? [r.t1, 1] : [r.t1, r.t2, 1];
    const p = { fractions, alpha: r.alpha, power: 1 - r.beta, spending: r.family, spendingParameter: r.par, futility: r.type === 'futility', futilitySpending: r.lfamily, futilityParameter: r.lpar, fixedSize: r.nfixed, evenTotal: true };
    const d = stats.sequentialDesign(p), tol = 1e-6;
    d.efficacy.forEach((b, k) => close(b, r[`b${k + 1}`], `efficacy ${k + 1}`, tol));
    if (r.type === 'futility') d.futility.forEach((a, k) => close(a, r[`a${k + 1}`], `futility ${k + 1}`, tol));
    close(d.inflation, r.inflation, 'inflation', tol);
    d.stopH1.forEach((s, k) => close(s, r[`h1stop${k + 1}`], `stop H1 ${k + 1}`, tol));
    d.stopH0.forEach((s, k) => close(s, r[`h0stop${k + 1}`], `stop H0 ${k + 1}`, tol));
    close(d.expectedH1, r.expectedH1, 'expected H1', tol); close(d.expectedH0, r.expectedH0, 'expected H0', tol);
    const out = stats.sequentialSampleSize(p);
    assert.equal(out.total, r.total); close(out.power, r.achieved, 'achieved', tol);
  });
}

test('one-look spending reduces to the fixed design', () => {
  for (const [family, parameter] of [['obf', 0], ['pocock', 0], ['power', 2], ['hsd', -4]]) close(stats.spending(1, .025, family, parameter), .025, family, 1e-12);
  const d = stats.sequentialDesign({ fractions: [.95, 1], alpha: .025, power: .9, spending: 'power', spendingParameter: 1, futility: false, fixedSize: 100 });
  assert.ok(d.inflation > 1 && d.inflation < 1.3);
});

// ---- Arena what-if table and the hazard-mode enrolment step (methods layer) ----
import { createRequire } from 'node:module';
const methods = createRequire(import.meta.url)('../journey/methods.js');

test('what-if: every fighter re-solves at another target power like a fresh calculation', () => {
  for (const m of Object.values(methods)) for (const mode of m.modes) {
    // Bell and Towel's fixed mode is an input size tied to its target power; tested below.
    if (mode.id === 'fixed') continue;
    const raw = { ...m.defaults, mode: mode.id }, p = m.normalize(raw);
    const totals = [];
    for (const t of [.8, .9, .95]) {
      const whatIf = m.solve(stats, { ...p, power: t }, m.id), fresh = m.solve(stats, m.normalize({ ...raw, power: String(t) }), m.id);
      assert.equal(whatIf.total, fresh.total, `${m.id}/${mode.id} at ${t}`);
      close(whatIf.power, fresh.power, `${m.id}/${mode.id} power at ${t}`, 1e-12);
      totals.push(whatIf.total);
    }
    assert.ok(totals[0] < totals[1] && totals[1] < totals[2], `${m.id}/${mode.id}: ${totals}`);
  }
});

test('what-if in fixed mode rescales the fixed-design size and keeps the effect', () => {
  for (const id of ['gsd-efficacy', 'gsd-futility']) {
    const m = methods[id], p = m.normalize({ ...m.defaults, mode: 'fixed' }), base = m.solve(stats, p, id);
    const at = t => m.solve(stats, { ...p, power: t }, id);
    assert.equal(at(Number(m.defaults.power)).total, base.total, id);
    assert.ok(at(.8).total < base.total && base.total < at(.95).total, id);
    for (const t of [.8, .95]) {
      const x = at(t);
      assert.ok(x.power >= t && x.power < t + .02, `${id} at ${t}: ${x.power}`);
      // Efficacy-only bounds do not depend on β, so the curve (planned design) agrees with the table.
      if (id === 'gsd-efficacy') close(m.powerAt(stats, p, x.total).power, x.power, `${id} curve at ${t}`, 1e-9);
    }
  }
});

test('Bell and Towel in hazard mode: enrolment converts the maximum events into participants', () => {
  for (const id of ['gsd-efficacy', 'gsd-futility']) {
    const m = methods[id], raw = { ...m.defaults, mode: 'hazard' }, p = m.normalize(raw), r = m.solve(stats, p, id);
    const rows = Object.fromEntries(m.resultTables(raw, p, r, stats).find(t => t.title === 'Enrolment from events').rows);
    const control = Math.LN2 / 12, eta = -Math.log(1 - .05), A = 12, F = 12;
    const pEvent = l => { const h = l + eta; return l / h * (1 - (Math.exp(-h * F) - Math.exp(-h * (A + F))) / (h * A)); };
    const expected = Math.ceil(r.total / ((pEvent(.7 * control) + pEvent(control)) / 2) - 1e-9);
    assert.equal(rows['Participants to enrol'], new Intl.NumberFormat('en-US').format(expected), id);
    assert.ok(expected > r.total, id);
    assert.deepEqual(m.shownExtras(raw), ['controlMedian', 'accrual', 'followUp', 'loss'], id);
    assert.deepEqual(m.shownExtras({ ...raw, mode: 'effect' }), ['dropout'], id);
    assert.equal(m.labelsFor(raw).unit, 'events', id);
    assert.equal(m.labelsFor({ ...raw, mode: 'effect' }).unit, 'participants', id);
    // Enrolment inputs never change the event count.
    assert.equal(m.solve(stats, m.normalize({ ...raw, controlMedian: '30', loss: '0.2' }), id).total, r.total, id);
    // Effect and fixed modes have no enrolment table.
    for (const mode of ['effect', 'fixed']) {
      const q = m.normalize({ ...raw, mode });
      assert.ok(!m.resultTables({ ...raw, mode }, q, m.solve(stats, q, id), stats).some(t => t.title === 'Enrolment from events'), `${id}/${mode}`);
    }
  }
});
