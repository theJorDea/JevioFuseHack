// Only repository-owned descriptors may select a guest adapter. Never load a module by user input.
import stream from './provider-stream-recovery.mjs';
import local from './lmstudio-tool-default.mjs';
export const adapters = new Map([stream,local].map(a=>[a.id,a]));
