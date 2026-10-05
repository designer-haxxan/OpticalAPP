// Prescription (Rx) UI: power steppers, form fields, display tables, editor dialog and printable Rx slip.
import * as UI from '../core/ui.js';
import { esc, today, fmtDate } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import { printHTML } from '../printer/printer.js';
import * as Optical from '../services/optical.js';

const $ = window.jQuery;
const blank = (v) => v === '' || v === null || v === undefined;

// ---------- formatting ----------
// Signed power with two decimals: +1.25, -2.00, 0.00. ASCII only, so it prints on any thermal printer.
export function fmtP(v) {
  if (blank(v) || Number.isNaN(Number(v))) return '';
  const n = Number(v);
  return n === 0 ? '0.00' : `${n > 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}
const fmtAxis = (v) => (blank(v) ? '' : String(Math.round(Number(v))));

// "-2.00 / -0.50 x 180  ADD +1.50"
export function eyeLine(e) {
  if (!Optical.eyeHasData(e)) return '—';
  const parts = [fmtP(e.sph) || 'Plano'];
  if (!blank(e.cyl) && Number(e.cyl) !== 0) parts.push(`/ ${fmtP(e.cyl)} x ${fmtAxis(e.axis)}`);
  if (!blank(e.add) && Number(e.add) !== 0) parts.push(`ADD ${fmtP(e.add)}`);
  return parts.join(' ');
}
export const rxLine = (rx) => (rx ? `R ${eyeLine(rx.od)}  ·  L ${eyeLine(rx.os)}${blank(rx.pd) ? '' : `  ·  PD ${rx.pd}`}` : '');

// Monospace rows for receipts: header + R + L (+ PD). Width ≤ 30 chars.
export function rxRows(rx) {
  const pad = (s, n) => String(s).padStart(n);
  const row = (tag, e) => `${tag}  ${pad(fmtP(e?.sph) || '-', 6)} ${pad(fmtP(e?.cyl) || '-', 6)} ${pad(fmtAxis(e?.axis) || '-', 4)} ${pad(fmtP(e?.add) || '-', 6)}`;
  const rows = [`${' '.repeat(3)}${pad('SPH', 6)} ${pad('CYL', 6)} ${pad('AXIS', 4)} ${pad('ADD', 6)}`, row('R', rx.od), row('L', rx.os)];
  if (!blank(rx.pd) || !blank(rx.pdNear)) rows.push(`PD ${[rx.pd, rx.pdNear].filter((x) => !blank(x)).join(' / ')} mm`);
  return rows;
}

// ---------- display ----------
export function rxTable(rx, { compact = false } = {}) {
  if (!rx) return '';
  const cell = (v, f) => `<td>${blank(v) ? '<span class="text-body-tertiary">–</span>' : esc(f(v))}</td>`;
  const eye = (tag, cls, e = {}) => `<tr><th class="eye ${cls}"><span>${tag}</span></th>${cell(e.sph, fmtP)}${cell(e.cyl, fmtP)}${cell(e.axis, fmtAxis)}${cell(e.add, fmtP)}</tr>`;
  return `<div class="rx-card ${compact ? 'compact' : ''}"><table class="rx-tbl"><thead><tr><th></th><th>SPH</th><th>CYL</th><th>AXIS</th><th>ADD</th></tr></thead>
    <tbody>${eye('R', 'od', rx.od)}${eye('L', 'os', rx.os)}</tbody></table>
    ${blank(rx.pd) && blank(rx.pdNear) ? '' : `<div class="rx-pd"><i class="bi bi-distribute-horizontal"></i> PD <b>${esc(rx.pd ?? '–')}</b>${blank(rx.pdNear) ? '' : ` · Near <b>${esc(rx.pdNear)}</b>`} mm</div>`}</div>`;
}

// ---------- form ----------
const STEP = { sph: [0.25, -20, 20, true], cyl: [0.25, -8, 8, true], add: [0.25, 0, 4, false], axis: [1, 0, 180, false] };

function stepper(eye, f, label, value) {
  const [, , , signed] = STEP[f];
  const shown = f === 'axis' ? (blank(value) ? '' : fmtAxis(value)) : fmtP(value);
  return `<div class="pw" data-f="${f}"><div class="pw-top"><label>${label}</label>${signed ? '<button type="button" class="pw-flip" tabindex="-1" aria-label="Flip sign">±</button>' : ''}</div>
    <div class="pw-ctl"><button type="button" class="pw-dec" tabindex="-1" aria-label="Decrease ${label}">−</button>
    <input name="${eye}_${f}" inputmode="${f === 'axis' ? 'numeric' : 'decimal'}" autocomplete="off" placeholder="${f === 'axis' ? '0' : '0.00'}" value="${esc(shown)}">
    <button type="button" class="pw-inc" tabindex="-1" aria-label="Increase ${label}">+</button></div></div>`;
}

export function rxFields(rx = {}, { showMeta = true } = {}) {
  const eyeBox = (eye, tag, name, cls) => `<div class="rx-eye ${cls}"><div class="rx-eye-head"><span class="eye-badge ${cls}">${tag}</span><b>${name}</b>
      ${eye === 'os' ? '<button type="button" class="btn btn-sm btn-light ms-auto rx-copy"><i class="bi bi-copy me-1"></i>Copy from right</button>' : ''}</div>
    <div class="pw-grid">${stepper(eye, 'sph', 'SPH', rx[eye]?.sph)}${stepper(eye, 'cyl', 'CYL', rx[eye]?.cyl)}${stepper(eye, 'axis', 'AXIS', rx[eye]?.axis)}${stepper(eye, 'add', 'ADD', rx[eye]?.add)}</div></div>`;
  return `<div class="rx-form">${eyeBox('od', 'R', 'Right eye (OD)', 'od')}${eyeBox('os', 'L', 'Left eye (OS)', 'os')}
    <div class="row g-2 mt-1">
      <div class="col-6"><label class="form-label">PD — distance (mm)</label><input name="pd" class="form-control" inputmode="decimal" placeholder="e.g. 62" value="${esc(rx.pd ?? '')}"></div>
      <div class="col-6"><label class="form-label">PD — near (mm)</label><input name="pdNear" class="form-control" inputmode="decimal" placeholder="optional" value="${esc(rx.pdNear ?? '')}"></div>
      ${showMeta ? `<div class="col-6"><label class="form-label">Test date</label><input name="date" type="date" class="form-control" max="${today()}" value="${esc(rx.date || today())}"></div>
      <div class="col-6"><label class="form-label">Doctor / optometrist</label><input name="doctor" class="form-control" maxlength="80" value="${esc(rx.doctor || '')}"></div>
      <div class="col-12"><label class="form-label">Purpose</label><select name="purpose" class="form-select">${['', 'Distance', 'Reading', 'Bifocal', 'Progressive', 'Computer / Blue-cut', 'Contact lens'].map((o) => `<option ${rx.purpose === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" maxlength="300" value="${esc(rx.note || '')}"></div>` : ''}
    </div></div>`;
}

// Parse typed text like "-2.5", "+1", "2.25" or "−3" (unicode minus) into a number, or null.
function parsePower(txt) {
  const n = parseFloat(String(txt ?? '').replace('−', '-').replace(/,/g, '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}
const quarter = (n) => Math.round(n * 4) / 4;

export function bindRxFields($root) {
  const setVal = ($pw, n) => {
    const f = $pw.data('f'); const [step, min, max] = STEP[f];
    n = Math.min(max, Math.max(min, f === 'axis' ? Math.round(n) : Math.round(n / step) * step));
    $pw.find('input').val(f === 'axis' ? String(n) : fmtP(n)).trigger('input');
  };
  const cur = ($pw) => parsePower($pw.find('input').val()) ?? 0;
  const bump = ($pw, dir) => { const f = $pw.data('f'); const [step] = STEP[f]; setVal($pw, cur($pw) + dir * step); };
  let timer = null; let interval = null;
  const stop = () => { clearTimeout(timer); clearInterval(interval); };
  $root.on('pointerdown', '.pw-inc, .pw-dec', function (e) {
    e.preventDefault();
    const $pw = $(this).closest('.pw'); const dir = $(this).hasClass('pw-inc') ? 1 : -1;
    bump($pw, dir); stop();
    timer = setTimeout(() => { interval = setInterval(() => bump($pw, dir), 70); }, 380);
  });
  $root.on('pointerup pointerleave pointercancel', '.pw-inc, .pw-dec', stop);
  $root.on('keydown', '.pw-inc, .pw-dec', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bump($(e.currentTarget).closest('.pw'), $(e.currentTarget).hasClass('pw-inc') ? 1 : -1); } });
  $root.on('click', '.pw-flip', function () { const $pw = $(this).closest('.pw'); const n = cur($pw); if (n !== 0) setVal($pw, -n); else $pw.find('input').trigger('focus'); });
  // Tidy typed values when leaving the field: 2.3 → +2.25, 180 axis stays an integer.
  $root.on('change', '.pw input', function () {
    const $pw = $(this).closest('.pw'); const f = $pw.data('f'); const n = parsePower(this.value);
    if (n === null) { this.value = ''; return; }
    const [, min, max] = STEP[f];
    const v = Math.min(max, Math.max(min, f === 'axis' ? Math.round(n) : quarter(n)));
    this.value = f === 'axis' ? String(v) : fmtP(v);
  });
  $root.on('click', '.rx-copy', () => {
    for (const f of ['sph', 'cyl', 'axis', 'add']) $root.find(`[name=os_${f}]`).val($root.find(`[name=od_${f}]`).val());
  });
}

export function fillRxFields($root, rx) {
  for (const eye of ['od', 'os']) for (const f of ['sph', 'cyl', 'axis', 'add']) {
    const v = rx?.[eye]?.[f]; $root.find(`[name=${eye}_${f}]`).val(blank(v) ? '' : f === 'axis' ? fmtAxis(v) : fmtP(v));
  }
  $root.find('[name=pd]').val(rx?.pd ?? ''); $root.find('[name=pdNear]').val(rx?.pdNear ?? '');
}

// Form values (from formModal) → { od, os, pd, pdNear } with raw strings; Optical.* validates and normalises.
export function readRx(v) {
  const eye = (e) => ({ sph: parsePower(v[`${e}_sph`]), cyl: parsePower(v[`${e}_cyl`]), axis: parsePower(v[`${e}_axis`]), add: parsePower(v[`${e}_add`]) });
  return { od: eye('od'), os: eye('os'), pd: parsePower(v.pd), pdNear: parsePower(v.pdNear) };
}

// ---------- dialogs ----------
export async function editRx({ customer, rx = null }) {
  return UI.formModal({
    title: rx ? 'Edit prescription' : `New prescription${customer ? ' — ' + customer.name : ''}`, size: 'md', submitLabel: 'Save prescription',
    body: rxFields(rx || {}),
    onShown: ($m) => { bindRxFields($m); $m.find('[name=od_sph]').trigger('focus'); },
    onSubmit: async (v) => {
      const saved = await Optical.savePrescription({ ...readRx(v), id: rx?.id, customerId: customer.id, date: v.date, doctor: v.doctor, purpose: v.purpose, note: v.note });
      UI.toast('Prescription saved');
      return saved;
    },
  });
}

// Printable Rx slip (A5) for the customer to take to any optician.
export function printRx(customer, rx) {
  const b = getSettings().business;
  const cell = (v, f) => (blank(v) ? '–' : esc(f(v)));
  const eye = (tag, e = {}) => `<tr><th>${tag}</th><td>${cell(e.sph, fmtP)}</td><td>${cell(e.cyl, fmtP)}</td><td>${cell(e.axis, fmtAxis)}</td><td>${cell(e.add, fmtP)}</td></tr>`;
  printHTML(`<div class="rx-slip">
    <div class="rx-slip-head"><div><div class="shop">${esc(b.name)}</div><div class="small">${esc([b.address, b.phone && 'Tel: ' + b.phone].filter(Boolean).join(' · '))}</div></div>
      <div class="ttl">Eye Prescription<div class="ur" dir="rtl">آنکھوں کا نسخہ</div></div></div>
    <div class="rx-slip-meta"><div>Patient: <b>${esc(customer.name)}</b>${customer.phone ? ` · ${esc(customer.phone)}` : ''}</div><div>Date: <b>${esc(fmtDate(rx.date))}</b></div>${rx.doctor ? `<div>Examined by: <b>${esc(rx.doctor)}</b></div>` : ''}${rx.purpose ? `<div>Purpose: <b>${esc(rx.purpose)}</b></div>` : ''}</div>
    <table class="rx-slip-tbl"><thead><tr><th></th><th>SPH</th><th>CYL</th><th>AXIS</th><th>ADD</th></tr></thead><tbody>${eye('Right (OD)', rx.od)}${eye('Left (OS)', rx.os)}</tbody></table>
    ${blank(rx.pd) && blank(rx.pdNear) ? '' : `<div class="rx-slip-pd">PD (distance): <b>${esc(rx.pd ?? '–')}</b> mm${blank(rx.pdNear) ? '' : ` &nbsp; PD (near): <b>${esc(rx.pdNear)}</b> mm`}</div>`}
    ${rx.note ? `<div class="rx-slip-note">Note: ${esc(rx.note)}</div>` : ''}
    <div class="rx-slip-sign"><span>Signature / Stamp</span></div></div>`, { page: 'A5' });
}
