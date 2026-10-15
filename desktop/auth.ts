import {AsyncLocalStorage} from 'node:async_hooks';
const local = new AsyncLocalStorage<boolean>();
export function withDesktopIdentity<T>(run: () => T): T { return local.run(true, run); }
export async function getChatGPTUser() {
  return local.getStore() ? {userId:'local-desktop-owner',displayName:'Desktop owner',email:'',fullName:null} : null;
}
