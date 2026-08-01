export interface CommandInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

export function platformCommand(
  command: string,
  args: string[],
  platform: string = process.platform,
): CommandInvocation {
  if (platform !== "win32") return { command, args, shell: false };
  const commandLine = [command, ...args].map(quoteForCmd).join(" ");
  return {
    command: commandLine,
    args: [],
    shell: true,
  };
}

function quoteForCmd(value: string) {
  if (/\r|\n/u.test(value)) throw new Error("Command arguments cannot contain newlines");
  const escaped = value.replaceAll("%", "%%").replaceAll('"', '""');
  return /[\s&|<>^"]/u.test(escaped) ? `"${escaped}"` : escaped;
}
