export type CliCommandAction = {
  transport: 'cli';
  kind: 'command';
  command: string;
};

export function buildCliClaimAction(reqId: string): CliCommandAction {
  return {
    transport: 'cli',
    kind: 'command',
    command: `npx auramaxx auth claim ${reqId} --json`,
  };
}

export function buildCliRetryAction(command: string): CliCommandAction {
  return {
    transport: 'cli',
    kind: 'command',
    command,
  };
}
