// Only repository-owned descriptors may select a guest adapter. Never load a module by user input.
import stream from './provider-stream-recovery.mjs';
import local from './lmstudio-tool-default.mjs';
import receipt from './cognee-data-receipt.mjs';
import web from './web-reload-busy.mjs';
import runner from './node-test-isolation-flag.mjs';
export const adapters = new Map([stream,local,receipt,web,runner].map(a=>[a.id,a]));
