// Entry for finish-probe-v4, under finish-probe-v4-protocol.md:
//   node frontend/eval/finishProbeV4Cli.js --phase inspect
//   node frontend/eval/finishProbeV4Cli.js --phase run --live
//   node frontend/eval/finishProbeV4Cli.js --phase report [--readme]
//   node frontend/eval/finishProbeV4Cli.js --phase analysis --live
// A dry check of the code on another campaign, written to its own folder:
//   node frontend/eval/finishProbeV4Cli.js --phase report --source a8-open-v5e --dry-journals .runs/finish-probe-v1/main/events.jsonl,.runs/finish-probe-v2/main/events.jsonl
import { installBrowserShims } from './bootstrap.js';

installBrowserShims();
const { runFinishProbeV4Command } = await import('./finishProbeV4.js');
process.exitCode = await runFinishProbeV4Command(process.argv.slice(2));
