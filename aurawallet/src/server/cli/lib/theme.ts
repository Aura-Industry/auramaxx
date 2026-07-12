/**
 * Aura CLI Theme — Medical / Industrial / Tyvek
 *
 * Shared visual primitives for all CLI commands.
 * Inspired by the AuraMaxx SVG logo system: registration corner marks,
 * three diagonal stripes at 45° (aura_logo.svg), dot micro-textures, monochrome fills.
 *
 * All output degrades safely in non-TTY / NO_COLOR / CI / TERM=dumb.
 */

import {
  getRandomStartBannerQuote,
  getStartBannerQuoteByIndex,
} from '../../../lib/startBannerQuotes';

// ── ANSI ─────────────────────────────────────────────────────

const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  fgAccent:'\x1b[38;5;154m',
  fgGreen: '\x1b[32m',
  fgRed:   '\x1b[31m',
  fgYellow:'\x1b[33m',
  fgWhite: '\x1b[97m',
  fgGray:  '\x1b[90m',
} as const;

export function supportsColor(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.CI === 'true') return false;
  return process.env.TERM !== 'dumb';
}

const USE_COLOR = supportsColor();

function isAurawalletFlavor(): boolean {
  const flavor = String(process.env.AURA_CLI_FLAVOR || '').trim().toLowerCase();
  return flavor === 'aurawallet' || flavor === 'wallet';
}

export function paint(text: string, ...codes: string[]): string {
  if (!USE_COLOR) return text;
  return `${codes.join('')}${text}${ANSI.reset}`;
}

// ── Constants ────────────────────────────────────────────────

const W = 62; // content width (fits 80-col with 2-char indent + padding)

export const SEPARATOR = '  ' + '- '.repeat(Math.floor(W / 2));

const CORNER_TL = paint('.-', ANSI.fgGray);
const CORNER_TR = paint('-.', ANSI.fgGray);
const CORNER_BL = paint("'-", ANSI.fgGray);
const CORNER_BR = paint("-'", ANSI.fgGray);

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (word.length <= width) {
      line = word;
      continue;
    }
    for (let i = 0; i < word.length; i += width) {
      lines.push(word.slice(i, i + width));
    }
    line = '';
  }
  if (line) lines.push(line);
  return lines;
}

function getBannerQuote(randomFn: () => number = Math.random): string {
  const forced = process.env.AURA_START_BANNER_QUOTE_INDEX;
  if (forced) {
    const forcedIndex = Number.parseInt(forced, 10);
    if (Number.isFinite(forcedIndex)) return getStartBannerQuoteByIndex(forcedIndex);
  }
  return getRandomStartBannerQuote(randomFn);
}

// ── Banner ───────────────────────────────────────────────────

/**
 * Print the Aura branded banner.
 *
 * Left side: three diagonal stripes at 45° inside a bordered square —
 * matching the canonical Aura logo (website/public/aura_logo.svg:
 * three rotated rects clipped to a square with corner marks).
 * Right side: AURA wordmark + subtitle.
 * Outer frame: crop-mark corners (from all SVG logos).
 */
export function printBanner(subtitle?: string): void {
  const sub = subtitle ? subtitle.toUpperCase() : '';
  const brandLine = isAurawalletFlavor() ? 'A U R A W A L L E T' : 'M A X X . S H';

  const P = paint('|', ANSI.fgGray);    // outer pipe
  const LP = paint('|', ANSI.fgGray);   // logo pipe
  const S = (t: string) => paint(t, ANSI.bold);  // stripe chars

  // Logo box borders (dashed, matching Tyvek style)
  const LT = paint('.', ANSI.fgGray) + paint('----------', ANSI.dim) + paint('.', ANSI.fgGray);
  const LB = paint("'", ANSI.fgGray) + paint('----------', ANSI.dim) + paint("'", ANSI.fgGray);

  // Three diagonal stripes inside a 12×5 square (≈ square at 2:1 char ratio)
  // All rows: |\\  \\  \\|
  const r1 = `${LP}${S('\\\\')}  ${S('\\\\')}  ${S('\\\\')}${LP}`;
  const r2 = `${LP}${S('\\\\')}  ${S('\\\\')}  ${S('\\\\')}${LP}`;
  const r3 = `${LP}${S('\\\\')}  ${S('\\\\')}  ${S('\\\\')}${LP}`;

  console.log('');
  console.log(`  ${CORNER_TL}${paint(' '.repeat(W - 4), ANSI.dim)}${CORNER_TR}`);
  console.log(`  ${P}   ${LT}${' '.repeat(W - 19)}${P}`);
  console.log(`  ${P}   ${r1}    ${paint('A U R A', ANSI.bold)}${' '.repeat(W - 30)}${P}`);
  console.log(`  ${P}   ${r2}    ${paint(brandLine, ANSI.dim)}${' '.repeat(Math.max(0, W - 25 - brandLine.length))}${P}`);
  console.log(`  ${P}   ${r3}    ${sub ? paint(sub, ANSI.fgAccent) : ''}${' '.repeat(Math.max(0, W - 23 - sub.length))}${P}`);
  console.log(`  ${P}   ${LB}${' '.repeat(W - 19)}${P}`);
  console.log(`  ${CORNER_BL}${paint(' '.repeat(W - 4), ANSI.dim)}${CORNER_BR}`);
  const quote = getBannerQuote();
  for (const line of wrapText(quote, W - 2)) {
    console.log(`  ${paint(line, ANSI.fgWhite, ANSI.italic)}`);
  }
  console.log('');
}

// ── Section ──────────────────────────────────────────────────

/**
 * Print a section header with Tyvek-style framing.
 *
 * Output:
 *   - - - - - - - - - - - - - - - - - - -
 *   [ SECTION TITLE ]
 *   Optional subtitle
 */
export function printSection(title: string, subtitle?: string): void {
  console.log('');
  console.log(SEPARATOR);
  console.log(`  ${paint(`[ ${title.toUpperCase()} ]`, ANSI.bold)}`);
  if (subtitle) {
    console.log(`  ${paint(subtitle, ANSI.dim)}`);
  }
  console.log('');
}

// ── Box ──────────────────────────────────────────────────────

/**
 * Print a framed box with crop-mark corners.
 * Replaces the old ╔═══╗ double-line Unicode boxes.
 *
 * Output:
 *   .- - - - - - - - - - - - - - - - -.
 *   |  Line 1                          |
 *   |  Line 2                          |
 *   '- - - - - - - - - - - - - - - - -'
 */
export function printBox(lines: string[]): void {
  const inner = W - 4; // account for "| " and " |"
  const dashes = '- '.repeat(Math.floor((W - 2) / 2));

  console.log(`  ${CORNER_TL}${paint(dashes.slice(0, W - 4), ANSI.dim)}${CORNER_TR}`);
  for (const line of lines) {
    // Strip ANSI to measure visible length for padding
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, inner - visible.length);
    console.log(`  ${paint('|', ANSI.fgGray)}  ${line}${' '.repeat(pad)}${paint('|', ANSI.fgGray)}`);
  }
  console.log(`  ${CORNER_BL}${paint(dashes.slice(0, W - 4), ANSI.dim)}${CORNER_BR}`);
}

// ── Status line ──────────────────────────────────────────────

/**
 * Print a key/value status line.
 *
 * Output:
 *     Label:        value
 *     Label:    [ok] value
 */
export function printStatus(label: string, value: string, ok?: boolean): void {
  const paddedLabel = label.padEnd(16);
  let indicator = '';
  if (ok === true) indicator = paint('[ok]', ANSI.fgGreen) + ' ';
  else if (ok === false) indicator = paint('[--]', ANSI.fgRed) + ' ';
  console.log(`    ${paint(paddedLabel, ANSI.dim)}${indicator}${value}`);
}

// ── Check result (for doctor) ────────────────────────────────

export type CheckBadge = 'pass' | 'warn' | 'fail';

/**
 * Format a diagnostic check badge in Tyvek style.
 */
export function checkBadge(status: CheckBadge): string {
  switch (status) {
    case 'pass': return paint('[PASS]', ANSI.fgGreen, ANSI.bold);
    case 'warn': return paint('[WARN]', ANSI.fgYellow, ANSI.bold);
    case 'fail': return paint('[FAIL]', ANSI.fgRed, ANSI.bold);
  }
}

// ── Completion ───────────────────────────────────────────────

/**
 * Print a branded completion message.
 */
export function printComplete(message: string): void {
  console.log('');
  console.log(SEPARATOR);
  console.log(`  ${paint('[ok]', ANSI.fgGreen)} ${paint(message, ANSI.bold)}`);
  console.log('');
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatProgressBar(current: number, total: number, width: number): string {
  const safeTotal = Math.max(1, total);
  const clamped = Math.max(0, Math.min(current, safeTotal));
  const filled = Math.round((clamped / safeTotal) * width);
  const active = paint('/'.repeat(filled), ANSI.fgAccent, ANSI.bold);
  const pending = paint('-'.repeat(Math.max(0, width - filled)), ANSI.dim);
  return `[${active}${pending}]`;
}

export interface ProgressDisplay {
  update(step: number, label: string, detail?: string): void;
  complete(label?: string, detail?: string): void;
}

export function createProgressDisplay(totalSteps: number, width = 24): ProgressDisplay {
  const stdout = process.stdout;
  const interactive = stdout.isTTY;
  let renderedLineCount = 0;

  function draw(step: number, label: string, detail?: string) {
    const safeStep = Math.max(0, Math.min(step, totalSteps));
    const titleLine = `  ${paint('//', ANSI.fgAccent, ANSI.bold)} ${paint(label, ANSI.bold)} ${paint(`${safeStep}/${totalSteps}`, ANSI.dim)} ${formatProgressBar(safeStep, totalSteps, width)}`;
    const lines = detail ? [titleLine, `     ${paint(detail, ANSI.dim)}`] : [titleLine];

    if (interactive && renderedLineCount > 0) {
      stdout.write(`\u001b[${renderedLineCount}A`);
      for (let index = 0; index < renderedLineCount; index += 1) {
        stdout.write('\u001b[2K');
        stdout.write('\u001b[1B');
      }
      stdout.write(`\u001b[${renderedLineCount}A`);
    }

    for (const line of lines) {
      if (interactive) {
        stdout.write('\u001b[2K');
        stdout.write(`${line}\n`);
      } else {
        console.log(stripAnsi(line));
      }
    }
    renderedLineCount = lines.length;
  }

  return {
    update(step: number, label: string, detail?: string) {
      draw(step, label, detail);
    },
    complete(label = 'Ready', detail?: string) {
      draw(totalSteps, label, detail);
    },
  };
}

// ── Seed phrase box (security-critical) ──────────────────────

/**
 * Display a seed phrase in a clearly framed box.
 * This is security-critical — readability is paramount.
 */
export function printSeedPhrase(mnemonic: string): void {
  const words = mnemonic.split(' ');
  const inner = 46;

  console.log('');
  console.log(`  ${CORNER_TL}${paint('-'.repeat(inner), ANSI.dim)}${CORNER_TR}`);
  console.log(`  ${paint('|', ANSI.fgGray)}  ${paint('SEED PHRASE', ANSI.bold)}${' '.repeat(inner - 14)}${paint('|', ANSI.fgGray)}`);
  console.log(`  ${paint('|', ANSI.fgGray)}  ${paint('Write this down. Store it safely.', ANSI.dim)}${' '.repeat(inner - 36)}${paint('|', ANSI.fgGray)}`);
  console.log(`  ${paint('|', ANSI.fgGray)}${' '.repeat(inner + 2)}${paint('|', ANSI.fgGray)}`);
  for (let i = 0; i < words.length; i += 4) {
    const line = words.slice(i, i + 4)
      .map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`)
      .join('');
    const pad = Math.max(0, inner - 2 - line.length);
    console.log(`  ${paint('|', ANSI.fgGray)}  ${line}${' '.repeat(pad)}${paint('|', ANSI.fgGray)}`);
  }
  console.log(`  ${paint('|', ANSI.fgGray)}${' '.repeat(inner + 2)}${paint('|', ANSI.fgGray)}`);
  console.log(`  ${paint('|', ANSI.fgGray)}  ${paint('It cannot be recovered.', ANSI.fgRed)}${' '.repeat(inner - 27)}${paint('|', ANSI.fgGray)}`);
  console.log(`  ${CORNER_BL}${paint('-'.repeat(inner), ANSI.dim)}${CORNER_BR}`);
  console.log('');
}

// ── Help formatter ───────────────────────────────────────────

/**
 * Print a branded help screen.
 */
export function printHelp(
  title: string,
  usage: string,
  commands: Array<{ name: string; desc: string }>,
  extras?: string[],
): void {
  printBanner(title);

  console.log(`  ${paint('Usage:', ANSI.bold)} ${usage}`);
  console.log('');

  if (commands.length > 0) {
    console.log(`  ${paint('Commands:', ANSI.bold)}`);
    const maxName = Math.max(...commands.map(c => c.name.length));
    for (const cmd of commands) {
      console.log(`    ${paint(cmd.name.padEnd(maxName + 2), ANSI.fgAccent)}${cmd.desc}`);
    }
    console.log('');
  }

  if (extras) {
    for (const line of extras) {
      console.log(`  ${line}`);
    }
    console.log('');
  }
}

export { ANSI, USE_COLOR, W };
