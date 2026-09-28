#!/usr/bin/env node
// The `chakra` command: `chakra init` and `chakra demo`. No CLI framework on purpose.

import { runDemo, startDemoServer } from './demo';
import { runInit, type Framework } from './init';

const HELP = `Usage: chakra <command> [options]

Commands:
  init   Write chakra.config.js with route priorities found in this project
         --force              overwrite an existing chakra.config.js
         --express|--fastify  framework, when package.json does not say
  demo   Overload a sample app and watch CHAKRA keep critical routes fast
         --seconds <n>        run time (default 30)
         --rps <n>            surge arrival rate (default 600)
         --off                the same surge without CHAKRA, for comparison
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const v = Number(args[args.indexOf(`--${name}`) + 1]);
    return flag(name) && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  switch (command) {
    case 'init': {
      const framework: Framework | undefined = flag('fastify')
        ? 'fastify'
        : flag('express')
          ? 'express'
          : undefined;
      const r = runInit({ force: flag('force'), framework });
      const n = Object.keys(r.routes).length;
      console.log(
        `Wrote ${r.file} with ${n} route${n === 1 ? '' : 's'}. Review the priorities, then add to your ${r.framework} app:\n`,
      );
      console.log(`${r.snippet.replace(/^/gm, '  ')}\n`);
      return 0;
    }
    case 'demo':
      await runDemo({
        seconds: value('seconds'),
        rps: value('rps'),
        mode: flag('off') ? 'off' : 'enforce',
      });
      return 0;
    case '__demo-server': {
      const { port } = await startDemoServer();
      process.send?.({ port });
      process.on('disconnect', () => process.exit(0));
      return -1; // keep running
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => code >= 0 && process.exit(code),
    (err: unknown) => {
      console.error(`chakra: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
