/**
 * Interactive prompts for CLI commands
 */

import * as readline from 'readline';
import { paint, ANSI } from './theme';

export interface PromptSelectOption {
  value: string;
  label: string;
  aliases?: string[];
}

function resolveSelectedValue(answer: string, options: PromptSelectOption[], defaultValue?: string): string {
  const normalized = answer.trim().toLowerCase();
  if (!normalized && defaultValue) return defaultValue;

  for (const opt of options) {
    const candidates = [opt.value, opt.label, ...(opt.aliases || [])].map((v) => v.toLowerCase());
    if (candidates.includes(normalized)) return opt.value;
  }

  return defaultValue || options[0].value;
}

function renderSelectLines(
  message: string,
  options: PromptSelectOption[],
  selectedIndex: number,
  defaultValue?: string,
): string[] {
  const lines = [
    message,
    paint('  Use up/down arrows and Enter to confirm.', ANSI.dim),
  ];

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const isDefault = defaultValue && option.value === defaultValue;
    const suffix = isDefault ? ' [default]' : '';
    if (i === selectedIndex) {
      lines.push(`  ${paint('//', ANSI.fgAccent, ANSI.bold)} ${paint(option.label + suffix, ANSI.bold)}`);
    } else {
      lines.push(`     ${paint(option.label + suffix, ANSI.dim)}`);
    }
  }

  return lines;
}

async function promptSelectInteractive(
  message: string,
  options: PromptSelectOption[],
  defaultValue?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const typedStdin = stdin as NodeJS.ReadStream & { isRaw?: boolean };

    const defaultIndex = Math.max(
      0,
      options.findIndex((opt) => opt.value === defaultValue),
    );
    let selectedIndex = defaultIndex;
    let renderedLines = 0;
    let settled = false;
    const wasRaw = typedStdin.isRaw ?? false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(wasRaw);
      }
      // Always restore paused mode after interactive prompts so the CLI can exit cleanly.
      // We intentionally do not preserve a flowing stdin state between prompts.
      stdin.pause();
    };

    const render = () => {
      const lines = renderSelectLines(message, options, selectedIndex, defaultValue);
      if (renderedLines > 0) {
        stdout.write(`\u001b[${renderedLines}A`);
      }
      for (const line of lines) {
        stdout.write('\u001b[2K');
        stdout.write(`${line}\n`);
      }
      renderedLines = lines.length;
    };

    const moveSelection = (delta: number) => {
      if (delta === 0) return;
      selectedIndex = (selectedIndex + delta + options.length) % options.length;
      render();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      const input = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let delta = 0;

      for (let i = 0; i < input.length; i += 1) {
        const c = input[i];
        if (c === '\u0003') {
          cleanup();
          stdout.write('\n');
          process.exit(1);
        }
        if (c === '\r' || c === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(options[selectedIndex].value);
          return;
        }
        if (input.startsWith('\u001b[A', i)) {
          delta -= 1;
          i += 2;
          continue;
        }
        if (input.startsWith('\u001b[B', i)) {
          delta += 1;
          i += 2;
          continue;
        }
      }

      if (delta !== 0) {
        moveSelection(delta);
      }
    };

    try {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on('data', onData);
      stdin.on('error', onError);
      render();
    } catch (error) {
      onError(error as Error);
    }
  });
}

/**
 * Prompt for a password with hidden input
 */
export async function promptPassword(label: string = 'Password'): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive password prompt requires a TTY. Use --password-stdin for automation.');
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    let settled = false;
    let password = '';

    stdout.write(`${label}: `);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw ?? false);
      }
      // Always restore paused mode after interactive prompts so the CLI can exit cleanly.
      stdin.pause();
    };

    const finish = () => {
      cleanup();
      stdout.write('\n');
      resolve(password);
    };

    const abort = () => {
      cleanup();
      stdout.write('\n');
      process.exit(1);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    stdin.resume();

    const onData = (chunk: Buffer | string) => {
      const input = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const c of input) {
        if (c === '\r' || c === '\n') {
          finish();
          return;
        }
        if (c === '\u0003') {
          // Ctrl+C
          abort();
          return;
        }
        if (c === '\u007f' || c === '\b') {
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
          continue;
        }
        password += c;
      }
    };

    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

/**
 * Prompt for visible text input
 */
export async function promptInput(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${label}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt user to select from explicit options
 */
export async function promptSelect(
  message: string,
  options: PromptSelectOption[],
  defaultValue?: string,
): Promise<string> {
  if (options.length === 0) throw new Error('promptSelect requires at least one option');

  if (process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function') {
    return promptSelectInteractive(message, options, defaultValue);
  }

  const optionLine = options
    .map((opt) => (defaultValue && opt.value === defaultValue ? `${opt.label} [default]` : opt.label))
    .join(' | ');

  const answer = await promptInput(`${message} (${optionLine})`);
  return resolveSelectedValue(answer, options, defaultValue);
}

/**
 * Prompt for yes/no confirmation
 */
export async function promptConfirm(msg: string): Promise<boolean> {
  const choice = await promptSelect(
    msg,
    [
      { value: 'yes', label: 'yes', aliases: ['y'] },
      { value: 'no', label: 'no', aliases: ['n'] },
    ],
    'yes',
  );
  return choice === 'yes';
}

/**
 * Wait for the user to press Enter
 */
export async function waitForEnter(msg: string = 'Press Enter to continue...'): Promise<void> {
  await promptInput(msg);
}
